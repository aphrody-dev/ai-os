#!/usr/bin/env sh
set -eu
BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"
(cd crates/aios-wasm-kernel && cargo build --target wasm32-unknown-unknown --release)
bun build --compile --minify src/cli.ts --outfile "${BIN_DIR}/ai-os"
echo "Installed single cross-platform + WASM/WebGPU binary: ${BIN_DIR}/ai-os"
