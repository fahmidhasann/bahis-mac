# BAHIS Mac development instructions

This is a personal, single-developer repository maintained on macOS with ChatGPT Codex.

- Do not spawn sub-agents, delegate work, or introduce team-oriented workflows.
- Work locally and keep changes focused on the user's current request.
- Never push, publish, release, delete data, reset a database, or change a remote without explicit user permission.
- Back up every SQLite database before schema changes, migrations, or destructive database operations.
- Keep production data in `bahis3.db` and development data in `bahis3_development.db`; never substitute one for the other.
- Keep secrets in ignored `.env.local` files. Never commit credentials, tokens, databases, logs, packaged apps, DMGs, or release artifacts.
- Use Node.js 22.23.2 from `.nvmrc` and install dependencies with `npm ci`.
- Before committing, run `npm run check`. For packaging changes, also run `npm run build:mac` and `npm audit`.
- Preserve the GPL-3.0 license, upstream authorship, and the read-only `upstream` remote.
