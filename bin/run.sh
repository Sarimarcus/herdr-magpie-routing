#!/bin/sh
# Herdr's server may not have nvm's node on PATH.
cd "$(dirname "$0")/.." || exit 1
NODE=$(command -v node 2>/dev/null)
[ -z "$NODE" ] && NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && { echo "magpie-routing: node not found"; sleep 30; exit 1; }
exec "$NODE" bin/view.js "$@"
