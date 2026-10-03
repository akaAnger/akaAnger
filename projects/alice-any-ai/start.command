#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf 'Установите Node.js 22 или новее: https://nodejs.org/\n'
  exit 1
fi
exec node start.mjs --open --tunnel
