#!/bin/sh
# Launcher for the BAHIS Patient Registry CLI.
#
# Mirrors run.sh (the MCP launcher) so both entry points share one set of environment defaults and
# cannot drift apart. Change a value in both, or neither.
#
# Unlike run.sh, stdout here is the CLI's JSON result and is meant to be piped or parsed.
# Diagnostics still go to stderr (>&2). exec keeps the exit code intact, which is the whole point:
# 0 success, 1 error, 2 batch partially verified.

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

BAHIS_DB_PATH="${BAHIS_DB_PATH:-$HOME/Library/Application Support/bahis/bahis3.db}"
BAHIS_MCP_ALLOW_PRODUCTION_WRITES="${BAHIS_MCP_ALLOW_PRODUCTION_WRITES:-1}"
export BAHIS_DB_PATH BAHIS_MCP_ALLOW_PRODUCTION_WRITES

BAHIS_MCP_NODE="${BAHIS_MCP_NODE:-$HOME/.local/bin/node}"
BAHIS_CLI_ENTRY="$BAHIS_MCP_HOME/dist/cli.js"

if [ ! -x "$BAHIS_MCP_NODE" ]; then
  echo "bahis: node not found or not executable: $BAHIS_MCP_NODE" >&2
  exit 1
fi

if [ ! -f "$BAHIS_CLI_ENTRY" ]; then
  echo "bahis: $BAHIS_CLI_ENTRY is missing - run 'npm run build' in $BAHIS_MCP_HOME" >&2
  exit 1
fi

exec "$BAHIS_MCP_NODE" "$BAHIS_CLI_ENTRY" "$@"
