#!/bin/sh
# Single source of truth for how the BAHIS Patient Registry MCP server starts.
#
# Every agent (Claude Code, Hermes, Codex) points its MCP config at this file and
# supplies nothing else, so these settings exist in exactly one place and cannot
# drift between agents. Change a value here and all agents pick it up on restart.
#
# stdio discipline: MCP frames its protocol over stdout, so this script must never
# print there. Send diagnostics to stderr (>&2) and use exec so the server owns the
# process, keeping signal handling and stream behaviour identical to a direct launch.

set -eu

# Resolve $0 through any symlinks before deriving the home directory. Without this, invoking the
# script via a symlink (e.g. ~/.local/bin/bahis) makes dirname report the symlink's directory and
# the entry point is looked up in the wrong place.
BAHIS_MCP_SELF=$0
while [ -L "$BAHIS_MCP_SELF" ]; do
  BAHIS_MCP_LINK=$(readlink "$BAHIS_MCP_SELF")
  case $BAHIS_MCP_LINK in
    /*) BAHIS_MCP_SELF=$BAHIS_MCP_LINK ;;
    *)  BAHIS_MCP_SELF=$(dirname -- "$BAHIS_MCP_SELF")/$BAHIS_MCP_LINK ;;
  esac
done

BAHIS_MCP_HOME=$(CDPATH= cd -- "$(dirname -- "$BAHIS_MCP_SELF")" && pwd -P)

# ${VAR:-default} lets a single agent override one setting via its own env block
# without the others having to change.
# Some agents spawn subprocesses with a sanitised environment, where HOME is unset.
# `set -u` would then abort on the lookups below, so recover it from the passwd
# entry - ~username expansion does not consult $HOME.
if [ -z "${HOME:-}" ]; then
  HOME=$(eval echo "~$(id -un)")
  export HOME
fi

# BAHIS_DB_PATH is deliberately NOT defaulted here. config.ts resolves the right location
# per platform (macOS ~/Library/Application Support, Windows %APPDATA%, else XDG), and a
# default in this script would silently override that with a macOS path. Set the variable
# only to point at a non-standard database.
BAHIS_MCP_ALLOW_PRODUCTION_WRITES="${BAHIS_MCP_ALLOW_PRODUCTION_WRITES:-1}"
export BAHIS_MCP_ALLOW_PRODUCTION_WRITES

# Prefer the pinned node, but fall back to whatever is on PATH so a machine that installed
# node normally still works.
BAHIS_MCP_NODE="${BAHIS_MCP_NODE:-$HOME/.local/bin/node}"
if [ ! -x "$BAHIS_MCP_NODE" ]; then
  BAHIS_MCP_NODE=$(command -v node || true)
fi
BAHIS_MCP_ENTRY="$BAHIS_MCP_HOME/dist/index.js"

if [ -z "$BAHIS_MCP_NODE" ] || [ ! -x "$BAHIS_MCP_NODE" ]; then
  echo "bahis-mcp: no usable node found - install Node 22.x or set BAHIS_MCP_NODE" >&2
  exit 1
fi

if [ ! -f "$BAHIS_MCP_ENTRY" ]; then
  echo "bahis-mcp: $BAHIS_MCP_ENTRY is missing — run 'npm run build' in $BAHIS_MCP_HOME" >&2
  exit 1
fi

exec "$BAHIS_MCP_NODE" "$BAHIS_MCP_ENTRY" "$@"
