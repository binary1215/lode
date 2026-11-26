#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$plugin_root/scripts/distribution.mjs" install --source "$plugin_root" "$@"
