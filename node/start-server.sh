#!/bin/sh
# Starts the local server (macOS / Linux). Build first:
#   (cd ../engine && cargo build --release) && npm install && (cd ../web && npm install && npm run build)
cd "$(dirname "$0")" && exec node server.mjs "$@"
