# Repository instructions for AI agents

This repository holds the BAHIS desktop application and the `bahis` Patient Registry CLI. It is
a private, single-maintainer development line of the GPL-3.0 upstream project, worked on with
AI coding agents on macOS, Windows or Linux.

## Setting things up

Follow [`README.md`](./README.md) in order — it is written as an executable procedure with a
gate after each phase. Do not skip a gate. In particular, the CLI cannot work until the desktop
application has synced the database once; no CLI command substitutes for that.

## Safety rules

- **Never push, publish, release, delete data, reset a database, or change a remote** without
  explicit permission.
- **Back up every SQLite database** before schema changes, migrations, or any destructive
  database operation.
- Keep production data in `bahis3.db` and development data in `bahis3_development.db`. Never
  substitute one for the other.
- Keep secrets in ignored `.env.local` files. Never commit credentials, tokens, databases, logs,
  packaged applications, DMGs, AppImages or release artifacts.
- Preserve the GPL-3.0 license, upstream authorship, and the read-only `upstream` remote.

## Working on the desktop application

Node 22.x, pinned in `.nvmrc`. Install with `npm ci`. Before committing run `npm run check`; for
packaging changes also run the build for your platform (`build:mac`, `build:win`, `build:linux`)
and `npm audit`.

## Working on the CLI

`bahis-cli/` is a **separate npm package** with its own `package.json`, `node_modules` and
lockfile. Run `npm ci` there too — the root install does not cover it.

**Agents execute `dist/`, not `src/`.** A fix that is never rebuilt silently leaves every agent
running the old code, with nothing anywhere reporting an error. After any change in
`bahis-cli/`, run:

```bash
npm run sync     # typecheck, test, rebuild dist/, then verify the whole installation
```

`npm run doctor` on its own verifies an installation without rebuilding. It exits non-zero on
failure, so it can gate a build.

Two more things fail silently and are worth checking by hand after changing them:

- The `bahis` command must resolve into this checkout. `npm link` guarantees it; a plain
  `npm install -g .` makes a detached copy that keeps running old code. `doctor` reports this.
- `skill/bahis-register-patients/SKILL.md` is linked into agent directories, never copied. Run
  `npm run install-skill` rather than copying it anywhere; a copy drifts with nothing reporting
  an error.

## Two BAHIS skills exist, and must not be merged

| Skill | Mechanism |
|---|---|
| `bahis-register-patients` (in this repo) | drives the `bahis` CLI. No VM, no UI. |
| `bahis-patient-draft-entry` (Codex only, outside this repo) | drives the BAHIS desktop app via VMware + Computer Use. |

Each skill's `description` must lead with its mechanism, or an agent will route to the wrong
one. Do not sync them.
