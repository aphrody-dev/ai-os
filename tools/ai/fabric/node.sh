#!/bin/sh
# Inference fabric compute node (Linux): official llama.cpp ggml-rpc-server, bound to a
# WireGuard address, in a capped transient systemd unit, removed on its own when its admission condition drops.
# Installed and driven by frameworks/ai-os/src/fabric (`ai-os fabric up|status|down`), never by hand:
#   env TAG= ASSET= SHA= BIND= PORT= THREADS= CPU= MEM= GATE= LOCK= PRIO= WATCH= COORD= sh node.sh <action>
# Actions: gate (code 0 = admitted, otherwise reason on stdout), up, down, status (one JSON line), watch (unit),
#   warm (MODEL_URL MODEL_SHA MODEL_FILE): GGUF pulled at data-center speed, verified, then loaded once
#   over loopback to fill rpc-server's tensor cache; the coordinator then only sends
#   fingerprints for tensors over 10 MiB (HASH_THRESHOLD of ggml-rpc.cpp).
# GATE : no-build (fr1), prd (charge, verrou lourd, service prioritaire, mémoire), proxy (fr2), always.
for _s in /usr/local/lib/aphrody/site.sh "$(dirname "$0")/../../../system/env-kit/loaders/shell/site.sh"; do [ -f "$_s" ] && { . "$_s"; break; }; done
set -eu
UNIT=aphrody-rpc
ROOT=/opt/aphrody
BIN_DIR="$ROOT/llama.cpp/${TAG:-none}"
CACHE=/var/cache/aphrody-rpc
STATE=/run/aphrody-rpc.state
nproc_=$(nproc)
half=$((nproc_ / 2))

load1() { cut -d' ' -f1 /proc/loadavg; }
# External load: while running, we only remove our own children (capped by CPUQuota).
load_ok() {
  own=${1:-0}
  awk -v l="$(load1)" -v o="$own" -v h="$half" 'BEGIN { exit !((l - o) < h) }'
}
mem_avail_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }
mem_need_mb() { echo "${MEM:-2G}" | awk '{ v = $1 + 0; u = substr($1, length($1)); if (u == "G") v *= 1024; print v + 2048 }'; }
BUILD_RE='ninja|autoninja|siso|reproxy|clang|clang\+\+|cc1plus|rustc|ld\.lld|lld-link'
building() { pgrep -x "$BUILD_RE" >/dev/null 2>&1; }

# Refusal reason on stdout, code 1; nothing and code 0 if admitted. $1 = own children to ignore (watch).
gate() {
  own=${1:-0}
  case "${GATE:-always}" in
    always) ;;
    no-build)
      building && { echo "build en cours : $(pgrep -xl "$BUILD_RE" | head -n1)"; return 1; }
      load_ok "$own" || { echo "charge $(load1) >= $half"; return 1; } ;;
    proxy)
      systemctl is-active --quiet nginx || { echo "nginx inactive: the proxy goes first"; return 1; }
      load_ok "$own" || { echo "charge $(load1) >= $half"; return 1; } ;;
    prd)
      load_ok "$own" || { echo "charge $(load1) >= $half"; return 1; }
      if [ -n "${PRIO:-}" ]; then
        code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$PRIO" || true)
        [ "$code" = 200 ] || { echo "service prioritaire $PRIO : HTTP $code"; return 1; }
      fi
      [ "$(mem_avail_mb)" -ge "$(mem_need_mb)" ] || { echo "available memory $(mem_avail_mb) MiB < $(mem_need_mb) MiB"; return 1; }
      # Opportunistic node: it never holds the heavy lock and withdraws as soon as heavy work takes it.
      if [ -n "${LOCK:-}" ]; then
        ( exec 9>"$LOCK"; flock -n 9 ) || { echo "verrou lourd $LOCK pris"; return 1; }
      fi ;;
    *) echo "gate inconnue : $GATE"; return 1 ;;
  esac
  return 0
}

rpc_bin() { find "$BIN_DIR" -maxdepth 3 -type f \( -name ggml-rpc-server -o -name rpc-server \) | head -n1; }

install_bin() {
  [ -n "$(rpc_bin 2>/dev/null || true)" ] && return 0
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/a.tgz" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ASSET"
  echo "$SHA  $tmp/a.tgz" | sha256sum -c --quiet - || { echo "invalid sha256 for $ASSET" >&2; rm -rf "$tmp"; exit 2; }
  mkdir -p "$BIN_DIR"
  tar -xzf "$tmp/a.tgz" -C "$BIN_DIR"
  rm -rf "$tmp"
  [ -n "$(rpc_bin)" ] || { echo "ggml-rpc-server missing from $ASSET" >&2; exit 2; }
}

nft_on() {
  command -v nft >/dev/null 2>&1 || { echo "nft missing: only the WireGuard listen address protects the port" >&2; return 0; }
  nft delete table inet aphrody_rpc 2>/dev/null || true
  nft -f - <<EOF
table inet aphrody_rpc {
  chain input {
    type filter hook input priority -10; policy accept;
    tcp dport $PORT ip saddr != { ${COORD:?COORD is the coordinator mesh address}, $BIND } drop
  }
}
EOF
}
nft_off() { command -v nft >/dev/null 2>&1 && nft delete table inet aphrody_rpc 2>/dev/null || true; }

# Unit body: rpc-server in the background, watchdog in the foreground.
watch() {
  bin=$(rpc_bin)
  mkdir -p "$CACHE"
  LLAMA_CACHE="$CACHE" GGML_RPC_NO_RDMA=1 "$bin" -H "$BIND" -p "$PORT" -t "${THREADS:-2}" -c &
  pid=$!
  trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; nft_off; exit 0' TERM INT
  echo "up $(date -u +%FT%TZ)" > "$STATE"
  while kill -0 "$pid" 2>/dev/null; do
    sleep "${WATCH:-10}"
    if why=$(gate "${THREADS:-2}"); then :; else
      echo "retrait $(date -u +%FT%TZ) : $why" | tee "$STATE"
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
      nft_off
      exit 0
    fi
  done
  echo "end $(date -u +%FT%TZ): rpc-server finished" > "$STATE"
  nft_off
}

up() {
  if systemctl is-active --quiet "$UNIT"; then echo "already active"; return 0; fi
  why=$(gate) || { echo "refus : $why"; exit 75; }
  install_bin
  nft_on
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  set -- systemd-run --unit "$UNIT" --collect --quiet \
    -p CPUQuota="${CPU:-100%}" -p MemoryMax="${MEM:-2G}" -p MemorySwapMax=0 -p CPUWeight=10 \
    -p Nice=19 -p IOSchedulingClass=idle -p IOWeight=10 -p OOMScoreAdjust=900 \
    --setenv=TAG="$TAG" --setenv=BIND="$BIND" --setenv=PORT="$PORT" --setenv=THREADS="${THREADS:-2}" \
    --setenv=GATE="${GATE:-always}" --setenv=PRIO="${PRIO:-}" --setenv=WATCH="${WATCH:-10}" \
    --setenv=MEM="${MEM:-2G}" --setenv=COORD="${COORD:-}"
  # prd: no lock held; watch tests the heavy lock on each tick (gate) and yields.
  "$@" sh "$ROOT/fabric/node.sh" watch
  sleep 2
  systemctl is-active --quiet "$UNIT" || { echo "failed: $(cat "$STATE" 2>/dev/null)"; journalctl -u "$UNIT" -n 20 --no-pager; exit 1; }
  echo "active on $BIND:$PORT"
}

MODELS=/var/cache/aphrody-models
warm() {
  systemctl is-active --quiet "$UNIT" || { echo "rpc-server inactif : up d'abord"; exit 1; }
  mkdir -p "$MODELS"
  f="$MODELS/$MODEL_FILE"
  if ! echo "$MODEL_SHA  $f" | sha256sum -c --quiet - 2>/dev/null; then
    nice -n 19 ionice -c3 curl -fsSL -o "$f.part" "$MODEL_URL"
    echo "$MODEL_SHA  $f.part" | sha256sum -c --quiet - || { rm -f "$f.part"; echo "sha256 invalide : $MODEL_URL"; exit 2; }
    mv "$f.part" "$f"
  fi
  cli=$(find "$BIN_DIR" -maxdepth 3 -type f -name llama-completion | head -n1)
  systemd-run --unit aphrody-rpc-warm --collect --wait --quiet \
    -p CPUQuota="${CPU:-100%}" -p MemoryMax="${MEM:-2G}" -p Nice=19 -p IOSchedulingClass=idle \
    "$cli" -m "$f" --rpc "$BIND:$PORT" -ngl 999 -n 1 -p ok --no-warmup -t 1 >/dev/null 2>&1 || true
  echo "cache: $(du -sm "$CACHE" | cut -f1) MiB in $CACHE"
}

down() { systemctl stop "$UNIT" 2>/dev/null || true; nft_off; echo "stopped"; }

status() {
  active=$(systemctl is-active "$UNIT" 2>/dev/null || true)
  own=0; [ "$active" = active ] && own=${THREADS:-2}
  why=$(gate "$own" 2>/dev/null) && admit=true || admit=false
  props=$(systemctl show "$UNIT" -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p CPUQuotaPerSecUSec -p MemoryMax 2>/dev/null | tr '\n' ' ')
  st=$(cat "$STATE" 2>/dev/null || true)
  printf '{"active":"%s","admit":%s,"reason":"%s","load1":%s,"nproc":%s,"mem_avail_mb":%s,"unit":"%s","state":"%s"}\n' \
    "$active" "$admit" "$why" "$(load1)" "$nproc_" "$(mem_avail_mb)" "$props" "$st"
}

case "${1:-status}" in
  gate) why=$(gate) && echo admis || { echo "$why"; exit 1; } ;;
  up) up ;;
  down) down ;;
  status) status ;;
  watch) watch ;;
  warm) warm ;;
  *) echo "action inconnue : $1" >&2; exit 64 ;;
esac
