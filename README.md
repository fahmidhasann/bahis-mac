# BAHIS-desk

This repository is a private development line of the GPL-3.0 BAHIS desktop application
(Bangladesh Animal Health Intelligence System). The original project history and authorship are
preserved. The personal repository is `origin`; `upstream` points to
`chameleonhub/chameleon-workstation` and has pushing disabled.

It contains **two** deliverables:

| | What it is | Where |
|---|---|---|
| **BAHIS desktop application** | The Electron app people use to enter and sync records. It owns the local database. | this directory |
| **`bahis` CLI** | A command line for validated Patient Registry entry, so an AI agent can register records without touching the app's UI. | [`bahis-cli/`](./bahis-cli) |

If you are an agent that was handed this repository to set up the CLI, read
**[Setting up the `bahis` CLI](#setting-up-the-bahis-cli)** below and follow it in order. It
works the same on macOS, Windows and Linux.

---

## Setting up the `bahis` CLI

Four phases. **Each phase ends with a gate — do not start the next phase until the gate
passes.** Everything here is the same on all three operating systems except where a table
splits by platform.

### Phase 0 — Get the code

This repository is **private**. Cloning it needs credentials.

```bash
gh auth login          # or: git clone https://<token>@github.com/<owner>/bahis-mac.git
git clone https://github.com/<owner>/bahis-mac.git
cd bahis-mac
```

If you do not have credentials, **stop and ask for them.** Do not look for a public mirror.

You also need **Node.js 22.x** — the exact version is pinned in [`.nvmrc`](./.nvmrc). Any
version manager works:

```bash
fnm use --install-if-missing     # or: nvm install && nvm use
node --version                   # must print v22.x
```

> **Gate:** `node --version` prints `v22.` and you are inside the repository directory.

### Phase 1 — Install the desktop application

The CLI cannot work until the desktop application has created the database and synced the
reference data. **This step is not optional and no CLI command can substitute for it.**

| Platform | How |
|---|---|
| **Windows** | Download and run the published `BAHIS_3.0.4.exe` installer from the upstream releases page. A signed, tested installer is more reliable than building Electron with native modules on a fresh machine. |
| **macOS** | Build it here: `npm ci && npm run build:mac`. The app and DMG are written to `release/3.0.4/`. The build is ad-hoc signed for personal use and is not notarized. |
| **Linux** | Build it here: `npm ci && npm run build:linux`. An AppImage is written to `release/3.0.4/` — it runs on any distribution with no package manager involved. |

Then **open the application, sign in, and let it sync at least once.** It writes the database
to:

| Platform | Database |
|---|---|
| macOS | `~/Library/Application Support/bahis/bahis3.db` |
| Windows | `%APPDATA%\bahis\bahis3.db` |
| Linux | `~/.config/bahis/bahis3.db` |

> **Gate:** that file exists and is more than a few kilobytes. If it does not exist, the sync
> did not finish — go back and sync again rather than continuing.

### Phase 2 — Install the CLI

Three commands, identical on every platform:

```bash
cd bahis-cli
npm ci
npm link
```

`npm link` compiles the TypeScript and puts a `bahis` command on `PATH`. npm creates the right
shim for the platform, including the `.cmd` wrapper on Windows, so **there is no `PATH` editing
to do by hand.** On Windows, open a new terminal afterwards.

No build tools are required — `better-sqlite3` ships prebuilt binaries for all three platforms,
so there is no node-gyp, Visual Studio or Xcode step.

Then verify:

```bash
npm run doctor
```

> **Gate:** every line reads `OK`. This is the real test — it checks the Node version, the
> build, the `PATH` install, the database, the skill, and makes a live call to the server.
> **Do not continue past a `FAIL`.** Each failure line names its own fix, and
> [`bahis-cli/README.md`](./bahis-cli/README.md#troubleshooting) has a table of all of them.
> If `authenticated` is false, run `bahis login -u <username> -p <password>` and re-run
> `doctor`.

### Phase 3 — Install the agent skill

```bash
npm run install-skill
```

This links `bahis-register-patients` into whichever agent skill directories exist on this
machine (`~/.claude/skills`, `~/.hermes/skills/productivity`, `~/.agents/skills`) and skips the
rest. On Windows it uses a directory junction, so no administrator rights are needed. If Codex
is installed, the script prints a `[[skills.config]]` block for you to paste into
`~/.codex/config.toml`.

For an agent with no skills system, paste
`bahis-cli/skill/bahis-register-patients/SKILL.md` in as instructions — it is plain Markdown
naming only shell commands.

> **Gate:** `npm run doctor` still passes, and the skill line lists at least one agent.

### Done

The agent now has one command, `bahis`, and one skill. Full command reference, exit codes and
safety model: [`bahis-cli/README.md`](./bahis-cli/README.md).

---

## Desktop application development

Run all commands from this repository root so the version manager can read `.nvmrc`.

```bash
fnm use --install-if-missing     # or: nvm install && nvm use
npm ci
npm run dev
```

Development mode expects local BAHIS and Kobo services by default. Override them in an ignored
`.env.local` file when using different endpoints. Never commit that file or any credentials.

Before committing a change:

```bash
npm run check
npm audit
```

For changes affecting Electron, native modules or packaging, also run the build for your
platform.

### Building for distribution

```bash
npm run build:mac      # DMG + .app, arm64
npm run build:win      # NSIS installer, x64
npm run build:linux    # AppImage, x64 + arm64
```

Output goes to `release/3.0.4/`. Application data lives in the platform paths listed in Phase 1;
production uses `bahis3.db`, development uses `bahis3_development.db`, and both write
diagnostics to `electron-debug.log`.

Automatic updates are disabled on macOS because the official update feed currently publishes
Windows packages only. Use **File > View official releases** and rebuild from a newer official
source tag when one becomes available.

To migrate an existing database, close both BAHIS installations, back up `bahis3.db`, then copy
it to the platform path above before starting the application.

### Windows build notes

Install Node 22.x from the Node.js website. When the installer offers to install additional
tools with Chocolatey, accept — that covers Visual Studio, Python and the other native-module
prerequisites. (This applies to *building the desktop app*. The `bahis` CLI needs none of it.)

### Known dependency follow-up

The readiness baseline has no critical or high npm audit findings. Two moderate React Router
findings remain and require a planned React Router 7 migration. **Do not run
`npm audit fix --force`** — it may introduce breaking framework changes.

Enketo declares support through Node 20 and prefers Yarn, while this build uses the
project-pinned Node 22 and npm. Treat the resulting engine messages as known warnings, and
re-run the form workflow smoke tests whenever Enketo, Node.js or the XML dependency overrides
change.

---

## Configuration

Three `.env` files are supported: `.env` (local development), `.env.staging`, `.env.production`.
A `.env.local` file, if present, is used instead of `.env` for local development.

Variables follow `VITE_[SCOPE]_[NAME]`, where `SCOPE` is one of `BAHIS`, `ELECTRON` or `REACT`
depending on whether the variable defines how the system talks to the BAHIS server, the Electron
main process, or the React renderer. Once read into the code they lose the `VITE_` prefix:
`VITE_BAHIS2_SERVER_URL` becomes `BAHIS2_SERVER_URL`.

```bash
# .env.local — for testing against a local server
VITE_BAHIS2_SERVER_URL=http://localhost
```

### Adding a new environment variable

**If it depends only on the build mode** (`development` / `staging` / `production`) and is read
in the Electron main process, hard-code it into the switch statement near the top of
[`electron/main.ts`](./electron/main.ts):

```typescript
let BAHIS2_SERVER_URL = 'http://www.bahis2-dev.net';

switch (import.meta.env.MODE) {
    case 'staging':
        BAHIS2_SERVER_URL = 'http://www.bahis2-dev.net';
        break;
    default:
        break;
}

// allow a .env file or the shell to override
if (import.meta.env.VITE_BAHIS2_SERVER_URL) {
    BAHIS2_SERVER_URL = import.meta.env.VITE_BAHIS2_SERVER_URL;
    log.warn('Overwriting BAHIS2_SERVER_URL based on environment variables or .env[.local] file.');
}
```

**If it varies by server or user:** put not-so-secret values (URLs) in `.env`, and secrets (keys,
passwords) in `.env.local` — then document the secret's existence here, never its value.

---

## Troubleshooting

**Format and lint.** `npm run format`; `npm run lint-electron` for Electron code and
`npm run lint-react` for React code.

**"core dumped" and Go errors.** Scroll up — if you see
`fatal error: all goroutines are asleep - deadlock!`, you are on the wrong Node version. Check
`node --version` against `.nvmrc`.

**better-sqlite3 `NODE_MODULE_VERSION` mismatch.** Confirm your Node version first, then run
`npm run fix-better-sqlite-build-error`.

**Too many watchers (Linux).** A leak in the UI code can exhaust inotify watches:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p
```

**Resetting the local database.** Delete the platform data directory — for example
`rm -rf ~/.config/bahis` on Linux. The exact location is printed to the console and recorded in
`electron-debug.log`.

**CLI problems** have their own table in
[`bahis-cli/README.md`](./bahis-cli/README.md#troubleshooting).
