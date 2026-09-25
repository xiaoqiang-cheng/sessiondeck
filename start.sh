#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: ./start.sh [--dev | --help]' \
    '' \
    'Default: install missing/outdated dependencies, build, and start SessionDeck.' \
    '--dev:   start with automatic reload instead of a production build.' \
    '' \
    'Requires Node.js 24+ and npm. Press Ctrl+C to stop.' \
    'Settings: SESSIONDECK_PORT, SESSIONDECK_DATA_DIR, SESSIONDECK_DEMO.' \
    'PORT overrides SESSIONDECK_PORT when both are set.'
}

if (( $# > 1 )); then usage >&2; exit 2; fi
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  ''|--dev) ;;
  *) usage >&2; exit 2 ;;
esac

project_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$project_dir"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 24+ is required. Install it and run this script again.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf 'Node.js 24+ is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm is required. Install it with Node.js and try again.' >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/tsx || ! -x node_modules/.bin/vite || ! -x node_modules/.bin/tsc \
   || ! -f node_modules/.package-lock.json \
   || package-lock.json -nt node_modules/.package-lock.json \
   || package.json -nt node_modules/.package-lock.json ]]; then
  printf '%s\n' 'Installing SessionDeck dependencies...'
  npm ci --include=dev
fi

if [[ "${1:-}" == --dev ]]; then
  exec ./node_modules/.bin/tsx watch server/index.ts --dev
fi

npm run build
# Keep Node as the foreground process so shutdown signals reach the server.
exec node --import tsx server/index.ts
