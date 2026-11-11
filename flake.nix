{
 description = "Sovereign AI-OS: Cross-Platform Bun + Rust + WASM32 + WebGPU + POSIX/Nix Control Plane";

 inputs = {
 nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
 rust-overlay.url = "github:oxalica/rust-overlay";
 };

 outputs = { self, nixpkgs, rust-overlay }:
 let
 supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
 forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
 in {
 packages = forAllSystems (system:
 let
 overlays = [ (import rust-overlay) ];
 pkgs = import nixpkgs { inherit system overlays; };
 rustToolchain = pkgs.rust-bin.stable.latest.default.override {
 targets = [ "wasm32-unknown-unknown" "wasm32-wasip1" ];
 };
 in {
 default = pkgs.stdenv.mkDerivation {
 pname = "ai-os";
 version = "2.1.0";
 src = ./.;
 nativeBuildInputs = [ pkgs.bun rustToolchain pkgs.zig pkgs.ripgrep pkgs.uutils-coreutils-noprefix ];
 buildPhase = ''
 cd crates/aios-wasm-kernel
 cargo build --target wasm32-unknown-unknown --release
 cd ../..
 bun build --compile --minify src/cli.ts --outfile ai-os
 '';
 installPhase = ''
 mkdir -p $out/bin $out/share/ai-os
 cp ai-os $out/bin/ai-os
 cp crates/aios-wasm-kernel/target/wasm32-unknown-unknown/release/aios_wasm_kernel.wasm $out/share/ai-os/
 '';
 };
 });
 };
}
