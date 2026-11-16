#!/usr/bin/env bash
# Provision fr2: JDK 25, official Ghidra release, pyghidra venv. Run: ssh <fr2> bash -s < provision-fr2.sh
set -euo pipefail
G=/srv/ghidra-release
URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip
SHA256=${GHIDRA_SHA256:-}
jv=$(java -version 2>&1 | sed -n '1s/.*"\([0-9]*\).*/\1/p' || true)
if [ "${jv:-0}" -lt 25 ]; then
  sudo -n apt-get update -q
  sudo -n apt-get install -y -q openjdk-25-jdk-headless unzip
fi
sudo -n mkdir -p "$G" && sudo -n chown "$(id -un)" "$G"
if [ ! -d "$G/ghidra_12.2_PUBLIC" ]; then
  curl -sSL -m 500 -o "$G/g.zip.part" "$URL"
  [ -z "$SHA256" ] || echo "$SHA256  $G/g.zip.part" | sha256sum -c -
  mv "$G/g.zip.part" "$G/g.zip"
  unzip -q -o "$G/g.zip" -d "$G"
fi
[ -d "$G/venv" ] || uv venv "$G/venv"
uv pip install -q --python "$G/venv/bin/python" pyghidra==3.2.0
echo provisioned
