#!/usr/bin/env bash
. "$(git rev-parse --show-toplevel)/system/env-kit/loaders/shell/site.sh"; FR1=$(site_ssh fr1)
# Usage: run from a machine with `ssh <fr1>` and `ssh prd`. No Chromium build is started.
set -euo pipefail
OUT=/srv/chromium/src/out/labs_agent-157.0.8103.78
SISO=/srv/chromium/src/third_party/siso/cipd/siso
here=$(cd "$(dirname "$0")" && pwd)
ssh "$FR1" "set -e; mkdir -p /tmp/bm; cd $OUT; nice -n 19 $SISO query graph -C . | nice -n 19 gzip -1 > /tmp/bm/graph.jsonl.gz;
  cp siso_metrics.0.json siso_metrics.json /tmp/bm/; cp ../re-test/siso_metrics.json /tmp/bm/retest_metrics.json"
tar cf - -C "$here" Cargo.toml src | ssh prd 'mkdir -p ~/bm/build-model && tar xf - -C ~/bm/build-model'
ssh prd 'set -e; mkdir -p ~/bm/data; cd ~/bm/data; ssh "$FR1"-wireguard "cd /tmp/bm && tar cf - ." | tar xf -
  zcat graph.jsonl.gz > graph.jsonl
  cd ~/bm/build-model && nice cargo +nightly test --release && nice cargo +nightly build --release
  cd ~/bm && nice build-model/target/release/build-model --graph data/graph.jsonl \
    --run1 data/siso_metrics.0.json --run2 data/siso_metrics.json --retest data/retest_metrics.json \
    --pool "mid=fr1:14:0.857:0,prd:4:1.077:0.025,fr2:3:0.819:0.025" \
    --pool "opt=fr1:14:0.857:0,prd:4:1.612:0.025,fr2:3:1.226:0.025" \
    --pool "coldcas=fr1:14:0.857:0,prd:4:1.077:11.07,fr2:3:0.819:11.07" \
    --boot 1000 --link 600,1800,3600
  rm -f data/graph.jsonl'
ssh "$FR1" 'rm -rf /tmp/bm'
