# BAHIS Patient Registry MCP

A local stdio MCP server for validated Patient Registry entry, Kobo submission, UUID-based verification, and local list reconciliation. It runs independently of Electron, so BAHIS may remain closed.

## Safety model

- Only the Patient Registry form is supported.
- No raw SQL, arbitrary URL, token, password, or full-XML tools are exposed.
- Every batch is validated completely before drafts are written or network submissions begin.
- Generated and server-returned dropdown values are validated against the current location and taxonomy choices before a record can be reported as verified.
- UUIDs are deterministic from `requestId` and record index, making retries idempotent.
- Failed records remain in BAHIS drafts. Verified records are written to the normal local cloud-submission table.
- Production submission requires the one-time environment setting `BAHIS_MCP_ALLOW_PRODUCTION_WRITES=1`.
- Optional form fields remain empty. Only active required fields and Kobo metadata are populated.

## Build and diagnose

```bash
npm ci
npm run check     # typecheck + tests
npm run build     # compile src/ -> dist/
npm run doctor
```

## Agent wiring — one source of truth

Claude Code, Hermes and Codex all run this server. They reach it through **`run.sh`**,
which is the only place the settings live:

```
.mcp.json (Claude Code) ─┐
config.yaml (Hermes) ────┼──> run.sh ──> node dist/index.js
config.toml (Codex) ─────┘     BAHIS_DB_PATH
                               BAHIS_MCP_ALLOW_PRODUCTION_WRITES
```

Each agent's config holds only the path to `run.sh` — no `args`, no `env`. Change a
setting in `run.sh` and every agent picks it up on restart. Registering a new agent is one
line pointing at the same file.

Every setting uses `${VAR:-default}`, so a single agent can still override one value in its
own config without affecting the others. `bahis-check.sh` reports any such override.

### After changing anything

```bash
npm run sync
```

This typechecks, runs the tests, rebuilds `dist/`, and verifies every agent. **Agents execute
`dist/`, not `src/`** — a fix that is never rebuilt silently leaves all three agents on the
old code, so prefer `npm run sync` over a bare `npm run build`.

Run `npm run verify:agents` on its own to check the wiring without rebuilding. It exits
non-zero on failure, and confirms: the build is fresh, `run.sh` is executable, all three
agents point at it, the Hermes skill symlink still resolves into this repo, and a live
`bahis_status` call succeeds with `semanticChoiceValidation` on.

Agents read their MCP config at startup, so restart them after a change. Hermes has
`mcp.auto_reload_on_config_change: true` and may pick it up without a restart;
`hermes mcp test bahis-patient-registry` confirms independently.

### The two BAHIS skills are different, on purpose

| Skill | Used by | Mechanism |
|---|---|---|
| `bahis-register-patients` | Claude Code, Hermes, Codex | calls the `bahis_*` MCP tools |
| `bahis-patient-draft-entry` | Codex | drives the BAHIS desktop app via VMware + Computer Use |

The first is one file all three agents read: Claude Code owns it, Hermes reaches it by
symlink (`~/.hermes/skills/productivity/…` → this repo's `.claude/skills/…`), and Codex
points at it by absolute path in a `[[skills.config]]` entry in `~/.codex/config.toml`.
No copies exist, so it cannot drift. The second uses no MCP tool at all and is
maintained separately — **do not sync them.**

## Agent usage

After restarting the MCP client, an agent should call `bahis_status`, then `bahis_patient_registry_context` and `bahis_patient_registry_recent_summary`, generate a constrained batch from current IDs and privacy-safe recent aggregates, and call `bahis_submit_patient_batch` with a unique `requestId`.

The recent-summary tool defaults to the latest 200 Patient Registry submissions. It returns aggregate clinical and location patterns only; it never returns owner names, mobile numbers, UUIDs, dates or raw XML.

## The `bahis` CLI

The same engine as the MCP, reached from a shell instead of a tool call. `src/service.ts`
holds every operation; `src/server.ts` wraps it for MCP and `src/cli.ts` wraps it for the
command line, so the two cannot behave differently.

```
bahis login    -u <username> -p <password>   sign in, refresh the stored token
bahis status                                 connectivity, auth and form-contract gates
bahis context  [--species goat,cattle]       valid unions, villages, species, signs, diagnoses
bahis summary  [--limit 200] [--order oldest|newest]
bahis validate --file records.json           every submit check, locally, writing nothing
bahis submit   --file records.json [--request-id X]
bahis verify   <batchId>
bahis retry    <batchId>
bahis batches  [--limit 20]                  recent batch history from the journal
```

`--file -` reads the JSON from stdin. Records are a plain array, or `{ "records": [...] }`
— the same shape `bahis_submit_patient_batch` takes.

### Contract

**stdout is JSON and nothing else.** Warnings and errors go to stderr as
`{"error": "...", "command": "..."}`, routed through `safeError()` so tokens and passwords
are redacted. A caller can pipe stdout straight into a parser.

**Exit codes carry the outcome**, so a script branches without reading prose:

| Code | Meaning |
|---|---|
| `0` | success — for `submit`/`verify`/`retry`, every record verified |
| `1` | error; for `submit` and `validate` this means nothing was written |
| `2` | the batch reached the server but not every record came back verified — retryable |

**Reruns are idempotent.** `--request-id` defaults to a hash of the records, so submitting
the same file twice resolves to the same batch id and the same deterministic UUIDs. The
journal recognises the batch and the server dedupes: no duplicate records.

**`validate` is the rehearsal.** It walks the identical prepare path as `submit` — remote
form contract, business rules, location resolution, XML build, semantic choices — without
staging, journalling or uploading. Use it before spending a real write against production.

### Installing

**macOS / Linux** - `npm run build`, then symlink the launcher onto `PATH`:

```sh
ln -sfn "$PWD/cli.sh" ~/.local/bin/bahis
```

**Windows** - `npm ci && npm run build`, then put this directory on `PATH` so `bahis.cmd`
resolves (one line, run once in PowerShell):

```powershell
$old = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', "$old;$PWD", 'User')
```

Read the *User* Path, not `$env:Path`. The latter is the User and Machine paths already
merged, so writing it back copies every system entry into the user's own Path - a mess that
is awkward to unpick later. Then open a new terminal for the change to take effect.

Either way the command is then just `bahis`, which is what the skill and every agent calls.

`cli.sh` and `bahis.cmd` are twins, and `cli.sh` mirrors `run.sh`: the environment defaults
live in one place per platform and cannot drift. Neither launcher sets `BAHIS_DB_PATH` -
`config.ts` resolves that per platform, and a default in a launcher would override it with
the wrong path on the other two.

### Windows notes

- **The desktop app must come first.** The CLI cannot create the database or the reference
  tables; only the BAHIS Electron app's own sync does that. Install the official
  `BAHIS_3.0.4.exe`, sign in, and let it sync once. The CLI then reads
  `%APPDATA%\bahis\bahis3.db`.
- **No build tools needed.** `better-sqlite3` ships prebuilt binaries for `win32-x64` and
  `win32-arm64`, so there is no node-gyp or Visual Studio step.
- **Node 22.x** is required (`engines` in `package.json`).
- `scripts/bahis-check.sh` (`npm run verify:agents`, `npm run sync`) and
  `npm run audit:dropdowns` are macOS/Linux developer tooling - POSIX shell, and the audit
  writes outside this directory. Neither is needed to register patients.

### What it does not do

No `pull`/`push` for modules, workflows, forms, taxonomies or administrative regions —
that logic lives in the desktop app's `electron/sync.ts`. Consequently `bahis login` can
refresh an expired token, but it cannot bootstrap a fresh machine: the desktop app must
have signed in and synced at least once to create the database and populate the reference
data that patient submission depends on.

### Using this from another agent

Two names are all an agent needs:

| | Name | Where |
|---|---|---|
| CLI | `bahis` | `~/.local/bin/bahis` -> `source/bahis-mcp/cli.sh` |
| Skill | `bahis-register-patients` | `.claude/skills/bahis-register-patients/SKILL.md` |

The CLI is a plain command, so any agent that can run a shell can use it - no MCP
server, no plugin, no protocol. Point the agent at the absolute launcher path if
`bahis` is not on its `PATH`:

```
/Users/fahmidhasantaohid/Documents/BAHIS-Mac-Development/source/bahis-mcp/cli.sh status
```

The launcher tolerates a sanitised environment: it recovers `HOME` from the passwd
entry and resolves its own directory through symlinks, so it works with no `PATH`,
no `HOME`, and from any working directory. That is deliberate - agents commonly
spawn subprocesses with a stripped environment.

For an agent with a skills system, install `bahis-register-patients` by pointing at
the file above (Hermes symlinks it, Codex references it by absolute path). For an
agent without one, paste the same SKILL.md in as instructions - it is plain Markdown
and names only shell commands, so nothing in it is agent-specific.

Whatever the agent, the division of labour is the same: the agent reads `context`
and `summary`, decides what records to write, and the CLI validates and submits
them. The CLI never invents records.
