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


# ── MCP is retired ─────────────────────────────────────────────────────────
# Agents now reach BAHIS through cli.sh, not the MCP server. The MCP's tool
# schemas cost ~3,600 tokens of context in every session, used or not, which is
# the whole reason it was switched off. These checks assert it stays off, so a
# stray re-registration cannot silently bring that cost back.
def _read(path, parse, mode="r"):
    try:
        with open(path, mode) as fh:
            return parse(fh)
    except FileNotFoundError:
        return None
    except (ValueError, yaml.YAMLError, tomllib.TOMLDecodeError):
        return "unreadable"


def mcp_entry(path, parse, key, mode="r"):
    """The MCP entry for this server, or None if the agent no longer registers it."""
    data = _read(path, parse, mode)
    if data in (None, "unreadable"):
        return data
    return (data or {}).get(key, {}).get(SERVER)


def codex_skill_entries():
    """Every [[skills.config]] entry Codex is configured to load."""
    with open(CODEX_CFG, "rb") as fh:
        return tomllib.load(fh).get("skills", {}).get("config", [])


section("MCP retired (agents use the CLI)")
claude = mcp_entry(CLAUDE_MCP, json.load, "mcpServers")
check("Claude Code: MCP not registered", claude is None,
      "" if claude is None else "still in .mcp.json — costs ~3.6k tokens per session")

hermes = mcp_entry(HERMES_CFG, yaml.safe_load, "mcp_servers")
hermes_off = hermes is None or (isinstance(hermes, dict) and hermes.get("enabled") is False)
check("Hermes: MCP disabled", hermes_off,
      "" if hermes_off else "enabled: true — set it to false")

codex = mcp_entry(CODEX_CFG, tomllib.load, "mcp_servers", "rb")
check("Codex: MCP not registered", codex is None,
      "" if codex is None else "still in ~/.codex/config.toml")

if hermes is not None and hermes_off:
    notes.append("Hermes keeps the disabled entry, so re-enabling is a one-word change")

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
# Config agreement is not proof anything runs. Invoke the CLI through its
# launcher exactly as a skill would, and confirm the safety gates are on.
section("Live probe (through cli.sh)")


def probe():
    """Run `cli.sh status` the way the skill does.

    Returns (status_dict_or_None, error_string). status reaches the network, so a
    single transient blip must not be reported as configuration drift - the caller
    retries once before failing.
    """
    try:
        proc = subprocess.run(
            [CLI_LAUNCHER, "status"],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out after 60s"
    except OSError as exc:
        return None, str(exc)

    if not proc.stdout.strip():
        return None, (proc.stderr.strip().splitlines() or ["no output"])[-1][:120]
    try:
        # The CLI's contract: stdout is JSON and nothing else. If anything else
        # leaked onto stdout, a caller parsing it would break - so fail here.
        return json.loads(proc.stdout), ""
    except json.JSONDecodeError:
        return None, f"stdout is not pure JSON: {proc.stdout.strip()[:60]}"


status, error = probe()
if status is None:
    notes.append(f"first probe attempt failed ({error}) - retrying once")
    status, error = probe()

if check("cli.sh status responds with JSON", status is not None, error):
    check("database found", status.get("databaseFound") is True)
    check("authenticated", status.get("authenticated") is True)
    check("server reachable", status.get("serverReachable") is True)
    # formCompatible now reflects the live server form, which is what gates a write.
    check("live form compatible", status.get("formCompatible") is True)
    # The gate whose absence caused the original drift incident.
    check("semanticChoiceValidation enabled", status.get("semanticChoiceValidation") is True)
    for warning in status.get("warnings") or []:
        notes.append(f"status warning: {warning}")

# ── Summary ────────────────────────────────────────────────────────────────
print()
for note in notes:
    print(f"  note: {note}")
if failures:
    print(f"\n{len(failures)} check(s) FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nAll checks passed — every agent runs the same CLI with the same settings.")
PY
