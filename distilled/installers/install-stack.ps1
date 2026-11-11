# Sovereign AI-OS Declarative Installer (Windows Userspace Only - Never touches System32)
$ErrorActionPreference = "Stop"
$BinDir = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Push-Location "C:\src\packages\ai-os\crates\aios-wasm-kernel"
cargo build --target wasm32-unknown-unknown --release
Pop-Location
Push-Location "C:\src\packages\ai-os"
bun build --compile --minify src/cli.ts --outfile (Join-Path $BinDir "ai-os.exe")
Pop-Location
Write-Output "Installed single cross-platform + WASM/WebGPU binary: $BinDir\ai-os.exe"
