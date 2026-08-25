#!/usr/bin/env node
/**
 * Verify a BAHIS CLI installation on any operating system.
 *
 * Plain Node, no dependencies, no shell: the previous version of this check was POSIX sh plus
 * python3 plus PyYAML, which meant the one command that tells an agent whether the install
 * worked could not run on the platform most likely to have got it wrong.
 *
 * Exits non-zero if anything is wrong, so it can gate a build. `npm run sync` runs it last.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig } from '../dist/config.js';

const require = createRequire(import.meta.url);
const HERE = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();
const SKILL_NAME = 'bahis-register-patients';
const CANONICAL_SKILL = path.join(HERE, 'skill', SKILL_NAME, 'SKILL.md');

const failures = [];
const notes = [];

function check(label, ok, detail = '') {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}

function section(title) {
    console.log(`\n${title}`);
}

function real(p) {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

// ── Node ───────────────────────────────────────────────────────────────────
section('Node');
const { engines } = require('../package.json');
const major = Number(process.versions.node.split('.')[0]);
check(
    `node ${process.versions.node} satisfies ${engines.node}`,
    major === 22,
    major === 22 ? '' : `install Node 22.x (see .nvmrc)`,
);

// ── Build freshness ────────────────────────────────────────────────────────
// This comes first among the install checks because it is the failure that hides best: agents
// execute dist/, not src/, so a fix that was never rebuilt silently freezes every agent on the
// old code with nothing anywhere reporting an error.
section('Build');
const entry = path.join(HERE, 'dist', 'cli.js');
if (check('dist/cli.js exists', fs.existsSync(entry), fs.existsSync(entry) ? '' : 'run: npm run build')) {
    const built = fs.statSync(entry).mtimeMs;
    const stale = [];
    for (const file of fs.readdirSync(path.join(HERE, 'src'), { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const full = path.join(file.parentPath, file.name);
        if (fs.statSync(full).mtimeMs > built) stale.push(path.relative(HERE, full));
    }
    check(
        'dist is newer than src (no rebuild needed)',
        stale.length === 0,
        stale.length === 0 ? '' : `${stale.length} stale file(s), e.g. ${stale[0]} — run: npm run build`,
    );
}

// ── PATH install ───────────────────────────────────────────────────────────
// The skill's whole contract is one word: `bahis`, resolved through PATH. Every agent dies at
// step 1 when that resolution is missing or lands somewhere else — which is exactly what moving
// or re-cloning the project does. Resolving PATH here rather than shelling out to which/where
// keeps this check working identically on Windows.
section('PATH install');
const FIX = 'run: npm link (from this directory)';

function whichBahis() {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        for (const ext of exts) {
            const candidate = path.join(dir, `bahis${ext}`);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
    }
    return null;
}

const resolved = whichBahis();
let probeCmd = null;
if (check('`bahis` is on PATH', resolved !== null, resolved ? resolved : FIX)) {
    probeCmd = resolved;
    // `npm link` resolves the shim straight into this checkout, so a rebuild takes effect at
    // once. `npm install -g .` installs a detached copy instead — it still runs, but code
    // changes here will not reach it, which is the kind of staleness that fails silently.
    const target = real(resolved) ?? '';
    if (!target.startsWith(real(HERE) ?? HERE)) {
        notes.push(`\`bahis\` runs a copy at ${target}, not this checkout — ${FIX} to keep them in step`);
    }
}

// ── Database ───────────────────────────────────────────────────────────────
// The CLI cannot create the database or the reference tables; only the desktop app's own sync
// does. A missing file here is not a CLI fault and no CLI command can fix it.
section('Database');
const config = loadConfig();
check(
    'database exists',
    fs.existsSync(config.dbPath),
    fs.existsSync(config.dbPath)
        ? config.dbPath
        : `not at ${config.dbPath} — install the BAHIS desktop app, sign in, and let it sync once`,
);

// ── Skill ──────────────────────────────────────────────────────────────────
// Config can be perfectly wired while an agent still reads instructions for the retired MCP and
// calls tools that no longer exist, so check the text itself — and check that no forgotten
// second copy is lying around for an agent to find instead.
section('Skill');
const MCP_ERA = [
    'bahis_status',
    'bahis_submit_patient_batch',
    'bahis_retry_patient_batch',
    'bahis_verify_patient_batch',
    'bahis_patient_registry_context',
    'bahis_patient_registry_recent_summary',
    'Registry MCP',
];
let text = null;
try {
    text = fs.readFileSync(CANONICAL_SKILL, 'utf8');
} catch (error) {
    check('SKILL.md is readable', false, String(error));
}
if (text !== null) {
    const found = MCP_ERA.filter((name) => text.includes(name)).sort();
    check(
        'skill has no retired-MCP instructions',
        found.length === 0,
        found.length === 0 ? '' : `still mentions ${found.join(', ')} — the MCP is gone`,
    );
    check(
        'skill drives the CLI',
        text.includes('bahis status') && text.includes('bahis submit'),
        text.includes('bahis status') ? '' : 'no `bahis status` / `bahis submit` steps found',
    );
}

// Every place an agent on this machine might discover the skill. A real directory here, rather
// than a link into this repo, is a copy that can silently drift — which is exactly what happened
// once in ~/.agents/skills. A root that does not exist just means that agent is not installed.
const SKILL_ROOTS = ['.claude/skills', '.hermes/skills', '.codex/skills', '.agents/skills'];
const canonical = real(CANONICAL_SKILL);
const installed = [];
const strays = [];

/** Every `bahis-register-patients` directory under a root, symlinked or real, at any depth. */
function findSkillDirs(dir, depth = 0) {
    const hits = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return hits;
    }
    for (const entry of entries) {
        // Dot-prefixed directories are archives and deliberate backups (~/.hermes/skills/.archive,
        // the kept MCP-era copy) — not something any agent loads, so not drift.
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === SKILL_NAME) {
            hits.push(full);
            continue;
        }
        // An installed skill is usually a symlink into a repo, and readdirSync does not descend
        // through one — so recurse on directories only, and let the name match above catch links.
        if (entry.isDirectory() && depth < 3) hits.push(...findSkillDirs(full, depth + 1));
    }
    return hits;
}

for (const relative of SKILL_ROOTS) {
    const root = path.join(HOME, relative);
    if (!fs.existsSync(root)) {
        notes.push(`~/${relative} does not exist — that agent is not installed here`);
        continue;
    }
    for (const dir of findSkillDirs(root)) {
        const found = real(path.join(dir, 'SKILL.md'));
        if (found === null) {
            strays.push(`${dir} (broken link)`);
        } else {
            (found === canonical ? installed : strays).push(dir);
        }
    }
}
check(
    'skill is installed for at least one agent',
    installed.length > 0,
    installed.length > 0 ? installed.map((p) => p.replace(HOME, '~')).join(', ') : 'run: npm run install-skill',
);
check(
    'no divergent copy of the skill anywhere',
    strays.length === 0,
    strays.length === 0 ? '' : `${strays.length} copy(ies) not resolving to this repo, e.g. ${strays[0]}`,
);

// ── Live probe ─────────────────────────────────────────────────────────────
// Config agreement is not proof anything runs. Invoke the CLI exactly as a skill would, through
// the PATH-resolved command, and confirm the safety gates are on.
section('Live probe (bahis status)');

function probe() {
    // status reaches the network, so a single transient blip must not be reported as a broken
    // install — the caller retries once before failing.
    const result = spawnSync(probeCmd, ['status'], { encoding: 'utf8', timeout: 60_000, shell: false });
    if (result.error) return [null, String(result.error.message ?? result.error)];
    if (!result.stdout?.trim()) return [null, (result.stderr?.trim().split('\n').pop() ?? 'no output').slice(0, 120)];
    try {
        // The CLI's contract: stdout is JSON and nothing else. If anything leaked onto stdout a
        // caller parsing it would break, so fail here rather than let it through.
        return [JSON.parse(result.stdout), ''];
    } catch {
        return [null, `stdout is not pure JSON: ${result.stdout.trim().slice(0, 60)}`];
    }
}

if (probeCmd === null) {
    check('bahis status responds with JSON', false, 'skipped — `bahis` is not usable on PATH');
} else {
    let [status, error] = probe();
    if (status === null) {
        notes.push(`first probe attempt failed (${error}) — retrying once`);
        [status, error] = probe();
    }
    if (check('bahis status responds with JSON', status !== null, error)) {
        check('database found', status.databaseFound === true);
        check('authenticated', status.authenticated === true, status.authenticated ? '' : 'run: bahis login -u <user> -p <password>');
        check('server reachable', status.serverReachable === true);
        check('production writes enabled', status.productionWritesEnabled === true);
        // formCompatible reflects the form live on the server, which is what actually gates a write.
        check('live form compatible', status.formCompatible === true);
        // The gate whose absence caused a silent-drift incident once before.
        check('semanticChoiceValidation enabled', status.semanticChoiceValidation === true);
        for (const warning of status.warnings ?? []) notes.push(`status warning: ${warning}`);
    }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log();
for (const note of notes) console.log(`  note: ${note}`);
if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
}
console.log('\nAll checks passed — the bahis CLI is installed and can write to the registry.');
