#!/usr/bin/env node
/**
 * Install the bahis-register-patients skill for every agent present on this machine.
 *
 * Links rather than copies. A copy is what drifted back to retired-MCP instructions once
 * before, with nothing reporting an error — a link cannot drift, because there is only ever
 * one file. On Windows the link is a directory junction, which needs no administrator rights
 * (a plain symlink there does).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const SKILL_NAME = 'bahis-register-patients';
const SOURCE = path.join(HERE, 'skill', SKILL_NAME);

// Where each agent looks. A root that does not exist means that agent is not installed here,
// which is not an error — the CLI works the same either way.
const TARGETS = [
    { agent: 'Claude Code', root: path.join(os.homedir(), '.claude', 'skills') },
    { agent: 'Hermes', root: path.join(os.homedir(), '.hermes', 'skills', 'productivity') },
    { agent: 'generic', root: path.join(os.homedir(), '.agents', 'skills') },
];

if (!fs.existsSync(path.join(SOURCE, 'SKILL.md'))) {
    console.error(`bahis: ${SOURCE}/SKILL.md is missing — is this the bahis-cli directory?`);
    process.exit(1);
}

function link(target) {
    // Replace whatever is there. A stale link into an old project location resolves to nothing
    // and the agent reports no error, it just silently loads no skill.
    fs.rmSync(target, { recursive: true, force: true });
    try {
        fs.symlinkSync(SOURCE, target, process.platform === 'win32' ? 'junction' : 'dir');
        return 'linked';
    } catch (error) {
        fs.cpSync(SOURCE, target, { recursive: true });
        console.warn(`  warning: could not link (${error.code}), copied instead — re-run this after editing SKILL.md`);
        return 'copied';
    }
}

let installed = 0;
for (const { agent, root } of TARGETS) {
    if (!fs.existsSync(root)) {
        console.log(`  skip     ${agent} — ${root.replace(os.homedir(), '~')} does not exist`);
        continue;
    }
    const target = path.join(root, SKILL_NAME);
    console.log(`  ${link(target).padEnd(8)} ${agent} — ${target.replace(os.homedir(), '~')}`);
    installed += 1;
}

// Codex has no skills directory; it reads entries from its config file instead, and a missing
// or `enabled = false` entry loads nothing and reports no error. Print the block to paste.
const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
if (fs.existsSync(codexConfig)) {
    // Compare resolved paths, not text: a correct entry often points at a symlink into this
    // repo rather than at the repo path itself, and a text match would miss it and tell the
    // user to add a duplicate.
    const canonical = fs.realpathSync(path.join(SOURCE, 'SKILL.md'));
    const already = [...fs.readFileSync(codexConfig, 'utf8').matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)].some(
        ([, value]) => {
            try {
                return fs.realpathSync(value) === canonical;
            } catch {
                return false;
            }
        },
    );
    console.log(
        already
            ? `\n  ok       Codex already points at this repo in ${codexConfig.replace(os.homedir(), '~')}`
            : `\nCodex is installed but configures skills by hand. Add this to ${codexConfig.replace(os.homedir(), '~')}:\n\n` +
              `[[skills.config]]\nname = "${SKILL_NAME}"\npath = "${path.join(SOURCE, 'SKILL.md')}"\nenabled = true\n`,
    );
}

if (installed === 0) {
    console.log('\nNo agent skill directories found. The `bahis` command still works on its own;');
    console.log(`for an agent without a skills system, paste ${path.join(SOURCE, 'SKILL.md')} in as instructions.`);
}
