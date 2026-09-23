#!/bin/sh
# Rebuilds everything: Rust engine (native + wasm), server deps, web app.   ./rebuild.sh
set -e
cd "$(dirname "$0")"
CARGO=cargo
command -v cargo >/dev/null 2>&1 || CARGO="$HOME/.cargo/bin/cargo"
RUSTUP=rustup
command -v rustup >/dev/null 2>&1 || RUSTUP="$HOME/.cargo/bin/rustup"

echo "== engine (cargo build --release)"
(cd engine && "$CARGO" build --release)
echo "== engine for the browser (wasm)"
"$RUSTUP" target add wasm32-unknown-unknown >/dev/null
(cd engine && "$CARGO" build --profile wasm --target wasm32-unknown-unknown --lib)
echo "== server deps (npm install)"
(cd node && npm install --no-audit --no-fund)
echo "== web (npm install + build)"
(cd web && npm install --no-audit --no-fund && npm run build)
echo "== done. local: node/start-server.sh; static hosting: upload web/dist"
