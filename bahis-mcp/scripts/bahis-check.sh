#!/bin/sh
# Verify the BAHIS MCP + skill are wired consistently across every agent.
#
# Run this after changing the MCP, the launcher, or any agent's config —
# `npm run sync` does it automatically as its last step.
#
# Exits non-zero if anything is wrong, so it can gate a build.

set -eu

MCP_HOME=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
export MCP_HOME

python3 - "$@" <<'PY'
import json
import os
import subprocess
import sys
import tomllib

import yaml

MCP_HOME = os.environ["MCP_HOME"]
LAUNCHER = os.path.join(MCP_HOME, "run.sh")
CLI_LAUNCHER = os.path.join(MCP_HOME, "cli.sh")
HOME = os.path.expanduser("~")

CLAUDE_MCP = os.path.join(MCP_HOME, "..", "..", ".mcp.json")
HERMES_CFG = os.path.join(HOME, ".hermes/config.yaml")
CODEX_CFG = os.path.join(HOME, ".codex/config.toml")
HERMES_SKILL = os.path.join(HOME, ".hermes/skills/productivity/bahis-register-patients")
PROJECT_SKILL = os.path.normpath(
    os.path.join(MCP_HOME, "..", "..", ".claude/skills/bahis-register-patients")
)
SERVER = "bahis-patient-registry"

failures = []
notes = []


def check(label, ok, detail=""):
    print(f"  {'OK  ' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    if not ok:
        failures.append(label)
    return ok


def section(title):
    print(f"\n{title}")


# ── Build freshness ────────────────────────────────────────────────────────
# Agents execute dist/, not src/. A fix that was never rebuilt silently freezes
# every agent on the old code at once, which is why this check comes first.
section("Build")
dist = os.path.join(MCP_HOME, "dist/index.js")
src = os.path.join(MCP_HOME, "src")
if check("dist/index.js exists", os.path.isfile(dist), "" if os.path.isfile(dist) else "run: npm run build"):
    dist_mtime = os.path.getmtime(dist)
    stale = [
        os.path.relpath(os.path.join(root, f), MCP_HOME)
        for root, _, files in os.walk(src)
        for f in files
        if os.path.getmtime(os.path.join(root, f)) > dist_mtime
    ]
    check(
        "dist is newer than src (no rebuild needed)",
        not stale,
        "" if not stale else f"{len(stale)} stale file(s), e.g. {stale[0]} — run: npm run build",
    )

# ── Launcher ───────────────────────────────────────────────────────────────
section("Launcher")
check("run.sh exists", os.path.isfile(LAUNCHER))
check("run.sh is executable", os.access(LAUNCHER, os.X_OK), "" if os.access(LAUNCHER, os.X_OK) else "run: chmod +x run.sh")
check("cli.sh exists", os.path.isfile(CLI_LAUNCHER))
check(
    "cli.sh is executable",
    os.access(CLI_LAUNCHER, os.X_OK),
    "" if os.access(CLI_LAUNCHER, os.X_OK) else "run: chmod +x cli.sh",
)
check("dist/cli.js exists", os.path.isfile(os.path.join(MCP_HOME, "dist", "cli.js")))


# ── Agent registrations ────────────────────────────────────────────────────
# The whole point: every agent must reach the MCP *through* the launcher, so the
# settings exist once. An agent carrying its own env is exactly the drift this
# scheme removes.
def entry_claude():
    with open(CLAUDE_MCP) as fh:
        return json.load(fh)["mcpServers"][SERVER]


def entry_hermes():
    with open(HERMES_CFG) as fh:
        return yaml.safe_load(fh)["mcp_servers"][SERVER]


def entry_codex():
    with open(CODEX_CFG, "rb") as fh:
        return tomllib.load(fh)["mcp_servers"][SERVER]


def codex_skill_entries():
    """Every [[skills.config]] entry Codex is configured to load."""
    with open(CODEX_CFG, "rb") as fh:
        return tomllib.load(fh).get("skills", {}).get("config", [])


section("Agent registrations")
for label, loader in (("Claude Code", entry_claude), ("Hermes", entry_hermes), ("Codex", entry_codex)):
    try:
        entry = loader()
    except FileNotFoundError:
        check(f"{label} registered", False, "config file not found")
        continue
    except (KeyError, ValueError, yaml.YAMLError, tomllib.TOMLDecodeError) as exc:
        check(f"{label} registered", False, f"could not read config: {exc}")
        continue

    ok = check(f"{label} → launcher", entry.get("command") == LAUNCHER, entry.get("command", "(no command)"))
    if ok and entry.get("env"):
        # Not fatal: an explicit override is legal via ${VAR:-default}. But it is
        # the one way values can diverge again, so surface it loudly.
        notes.append(f"{label} sets its own env ({', '.join(entry['env'])}) — overrides the launcher default")
    if label == "Hermes" and entry.get("enabled") is False:
        check("Hermes server enabled", False, "enabled: false")

# ── Skill ──────────────────────────────────────────────────────────────────
# All three agents run the same bahis-register-patients file: Claude Code owns it,
# Hermes symlinks to it, Codex points at it by absolute path in [[skills.config]].
#
# Codex's bahis-patient-draft-entry is still deliberately NOT checked here. It is a
# different skill that drives the desktop app via Computer Use and uses no MCP tool —
# a separate artifact, never synced with this one.
section("Skill (all agents)")
check("project skill directory exists", os.path.isdir(PROJECT_SKILL))
is_link = os.path.islink(HERMES_SKILL)
check("Hermes path is a symlink", is_link, "" if is_link else "a real directory here means the copies can drift")
if is_link:
    target = os.path.realpath(HERMES_SKILL)
    check("symlink resolves into the project", target == os.path.realpath(PROJECT_SKILL), target)

# Codex loads the skill by path rather than by directory, so the failure mode is a
# stale path or a silently disabled entry — neither of which surfaces as an error.
project_skill_md = os.path.realpath(os.path.join(PROJECT_SKILL, "SKILL.md"))
try:
    entries = codex_skill_entries()
except FileNotFoundError:
    check("Codex points at the project SKILL.md", False, "config file not found")
except (ValueError, tomllib.TOMLDecodeError) as exc:
    check("Codex points at the project SKILL.md", False, f"could not read config: {exc}")
else:
    matches = [e for e in entries if os.path.realpath(str(e.get("path", ""))) == project_skill_md]
    if check(
        "Codex points at the project SKILL.md",
        bool(matches),
        "" if matches else f"add a [[skills.config]] entry with path = {project_skill_md}",
    ):
        enabled = matches[0].get("enabled", True)
        check("Codex skill entry is enabled", enabled is not False, "" if enabled is not False else "enabled = false")

# ── Live probe ─────────────────────────────────────────────────────────────
# Config agreement is not proof the server runs. Start it through the launcher
# exactly as an agent would and confirm the safety gate is on.
section("Live probe (through the launcher)")
requests = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "bahis-check", "version": "1"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
     "params": {"name": "bahis_status", "arguments": {}}},
]


def probe():
    """Start the server through the launcher exactly as an agent would.

    Returns (status_dict_or_None, error_string). bahis_status reaches the network,
    so a single transient blip must not be reported as configuration drift —
    the caller retries once before failing.
    """
    try:
        proc = subprocess.run(
            [LAUNCHER],
            input="\n".join(json.dumps(r) for r in requests) + "\n",
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out after 60s"

    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return None, f"stray output corrupts MCP framing: {line[:60]}"
        if msg.get("id") == 2:
            result = msg.get("result", {})
            # The real payload is in structuredContent; content[0].text is only a
            # human-readable summary line.
            status = result.get("structuredContent")
            if status is None:
                return None, f"unexpected result shape: {json.dumps(result)[:80]}"
            return status, ""
    return None, (proc.stderr.strip().splitlines() or ["no response"])[-1][:120]


status, error = probe()
if status is None:
    notes.append(f"first probe attempt failed ({error}) — retrying once")
    status, error = probe()

if check("server responds to bahis_status", status is not None, error):
    check("database found", status.get("databaseFound") is True)
    check("authenticated", status.get("authenticated") is True)
    check("server reachable", status.get("serverReachable") is True)
    # The gate whose absence caused the original drift incident.
    check("semanticChoiceValidation enabled", status.get("semanticChoiceValidation") is True)
    for warning in status.get("warnings") or []:
        notes.append(f"server warning: {warning}")

# ── Summary ────────────────────────────────────────────────────────────────
print()
for note in notes:
    print(f"  note: {note}")
if failures:
    print(f"\n{len(failures)} check(s) FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nAll checks passed — every agent runs the same MCP with the same settings.")
PY
