# BAHIS Patient Registry CLI

`bahis` is a command line for validated Patient Registry entry, Kobo submission, UUID-based
verification and local list reconciliation. It runs independently of Electron, so the BAHIS
desktop application may stay closed.

It is a plain command on `PATH`, so any agent that can run a shell can drive it — no MCP
server, no plugin, no protocol. Installation is the same three commands on macOS, Windows and
Linux.

---

## Before you install: the desktop app must come first

The CLI **cannot create the database or the reference tables.** Only the BAHIS desktop
application's own sync does that. Until the app has been installed, signed in to, and synced
once, every CLI command will fail with "database not found" and no CLI command can fix it.

| Platform | Where the database ends up |
|---|---|
| macOS | `~/Library/Application Support/bahis/bahis3.db` |
| Windows | `%APPDATA%\bahis\bahis3.db` |
| Linux | `~/.config/bahis/bahis3.db` |

See the [root README](../README.md) for how to get the desktop app on each platform.

---

## Install

Three commands, identical on every platform. Run them from this directory.

```
npm ci
npm link
npm run doctor
```

- `npm ci` installs dependencies and the TypeScript toolchain.
- `npm link` compiles `src/` → `dist/` and puts a `bahis` command on `PATH`. npm creates the
  right kind of shim for the platform, including the `.cmd` wrapper on Windows — there is no
  `PATH` editing to do by hand.
- `npm run doctor` proves the install works, end to end, including a live call to the server.

**Every line of `doctor` must read `OK` before you continue.** It is the gate: if it does not
pass, nothing downstream will work, and the failure line names the fix.

`npm link` is deliberate rather than `npm install -g .`. Link resolves the command straight
into this checkout, so a `npm run build` takes effect immediately. A global install makes a
detached copy that silently keeps running old code after you change something here.

**No build tools are needed.** `better-sqlite3` ships prebuilt binaries for macOS, Windows
(x64 and arm64) and Linux, so there is no node-gyp, Visual Studio or Xcode step. Node 22.x is
required, as pinned in `engines`.

### Sign in

If `doctor` reports `authenticated` as false:

```
bahis login -u <username> -p <password>
```

---

## Commands

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

`--file -` reads the JSON from stdin. Records are a plain array, or `{ "records": [...] }`.

`summary` defaults to the latest 200 Patient Registry submissions and returns aggregate
clinical and location patterns only — never owner names, mobile numbers, UUIDs, dates or raw
XML.

---

## The contract

**stdout is JSON and nothing else.** Warnings and errors go to stderr as
`{"error": "...", "command": "..."}`, routed through `safeError()` so tokens and passwords are
redacted. A caller can pipe stdout straight into a parser.

**Exit codes carry the outcome,** so a script branches without reading prose:

| Code | Meaning |
|---|---|
| `0` | success — for `submit`/`verify`/`retry`, every record verified |
| `1` | error; for `submit` and `validate` this means nothing was written |
| `2` | the batch reached the server but not every record came back verified — retryable |

**Reruns are idempotent.** `--request-id` defaults to a hash of the records, so submitting the
same file twice resolves to the same batch id and the same deterministic UUIDs. The journal
recognises the batch and the server dedupes: no duplicate records.

**`validate` is the rehearsal.** It walks the identical prepare path as `submit` — remote form
contract, business rules, location resolution, XML build, semantic choices — without staging,
journalling or uploading. Use it before spending a real write against production.

---

## Safety

- Only the Patient Registry form is supported.
- No raw SQL, arbitrary URL, token, password or full-XML commands exist.
- Every batch is validated completely before drafts are written or network submissions begin.
- Generated and server-returned dropdown values are checked against the current location and
  taxonomy choices before a record can be reported as verified.
- UUIDs are deterministic from `requestId` and record index, making retries idempotent.
- Failed records remain in BAHIS drafts. Verified records are written to the normal local
  cloud-submission table.
- Optional form fields are left empty. Only active required fields and Kobo metadata are set.

### Production writes

`bahis` sets `BAHIS_ALLOW_PRODUCTION_WRITES=1` for itself when the variable is unset, because
registering patients against the live registry is what the command exists for. To put the gate
back in the way, set it explicitly to something else:

```
BAHIS_ALLOW_PRODUCTION_WRITES=0 bahis submit --file records.json    # refused
```

`validate` never writes, whatever this is set to.

### Environment

Every variable is optional; the defaults are correct for a normal installation.

| Variable | Default |
|---|---|
| `BAHIS_DB_PATH` | the platform path in the table above |
| `BAHIS_JOURNAL_PATH` | `bahis-mcp.db` beside the database |
| `BAHIS_SERVER_URL`, `BAHIS_KOBO_KF_API_URL`, `BAHIS_KOBO_KC_API_URL` | production endpoints |
| `BAHIS_ALLOW_PRODUCTION_WRITES` | `1` |

The older `BAHIS_MCP_*` spellings are still read as a fallback. The journal file keeps its
historic `bahis-mcp.db` name on purpose: it holds the batch history that makes a rerun
idempotent, and renaming the default would orphan it.

---

## The skill

`skill/bahis-register-patients/SKILL.md` tells an agent how to generate and register a batch.
Install it for every agent on this machine:

```
npm run install-skill
```

This links — never copies — the skill into `~/.claude/skills`, `~/.hermes/skills/productivity`
and `~/.agents/skills`, skipping any that do not exist, and uses a directory junction on
Windows so no administrator rights are needed. A link cannot drift; a copy silently can, which
is how a stale copy once kept an agent calling tools that no longer existed.

Codex configures skills by hand. If `~/.codex/config.toml` exists, the script prints the exact
`[[skills.config]]` block to paste, including `enabled = true` — a disabled entry loads nothing
and reports no error.

For an agent with no skills system, paste `SKILL.md` in as instructions. It is plain Markdown
naming only shell commands, so nothing in it is agent- or OS-specific.

---

## Development

```
npm run check     # typecheck + tests
npm run build     # compile src/ -> dist/
npm run doctor    # verify the installation end to end
npm run sync      # check, build, then doctor — run this after any change
```

**Agents execute `dist/`, not `src/`.** A fix that is never rebuilt silently leaves every agent
on the old code, so prefer `npm run sync` over a bare `npm run build`.

`src/service.ts` holds every operation and `src/cli.ts` wraps it for the command line. The
retired MCP server was removed in favour of the CLI; it is recoverable from git history.

`npm run audit:dropdowns` writes a CSV of every dropdown value outside this directory. It is
developer tooling, not part of registering patients.

---

## What it does not do

No `pull`/`push` for modules, workflows, forms, taxonomies or administrative regions — that
logic lives in the desktop application's `electron/sync.ts`. Consequently `bahis login` can
refresh an expired token, but it cannot bootstrap a fresh machine.

---

## Troubleshooting

Each row is a `npm run doctor` failure line.

| Failure | Fix |
|---|---|
| `node ... satisfies` | Install Node 22.x. `.nvmrc` in the repo root pins the exact version. |
| `dist/cli.js exists` | `npm ci && npm run build` |
| `dist is newer than src` | `npm run build` — the code changed and agents run `dist/`. |
| `` `bahis` is on PATH `` | `npm link` from this directory. Then open a new terminal. |
| note: `bahis` runs a copy | You used `npm install -g .`. Run `npm uninstall -g bahis-cli`, then `npm link`. |
| `database exists` | Install the desktop app, sign in, and let it sync once. The CLI cannot create it. |
| `skill is installed` | `npm run install-skill` |
| `no divergent copy of the skill` | A stale copy or a broken link is shadowing the real skill. `npm run install-skill` replaces it. |
| `authenticated` | `bahis login -u <username> -p <password>` |
| `server reachable` | Check the network. The endpoints are in `src/constants.ts`. |
| `live form compatible` | The server's form changed. The CLI must be updated to match the new contract. |
| status warning: cached form out of date | Harmless. Records are always built from the live form; open BAHIS and sync when convenient. |
