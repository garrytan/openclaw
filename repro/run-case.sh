#!/usr/bin/env bash
# usage: OC=<openclaw bin dir> FIX=realistic TAG=<name> W=<workdir> [MIGRATE=1] [HEAP=16g|default] [TURNS=3] [COMPACT=1] bash run-case.sh
# case runner. HEAP selects the gateway heap flag (16g = the box's --max-old-space-size=16384,
# default = no heap flag), COMPACT=1 adds a compaction-triggering turn (safeguard mode + small maxActiveTranscriptBytes,
# hot-reloaded), TMPDIR is per run, /tmp/openclaw (logs, archive read cache) is cleared and measured per run,
# and the preload takes SQLite-worker heap snapshots at 380/480 MB.
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd); R=$W/run-$TAG; GPORT=${GPORT:-19811}; MPORT=${MPORT:-19870}; TURNS=${TURNS:-3}; HEAP=${HEAP:-16g}
pkill -f "mock.cjs $MPORT" 2>/dev/null; pkill -f openclaw-gateway 2>/dev/null; pkill -f 'openclaw gateway run' 2>/dev/null; sleep 2
rm -rf "$R"; cp -a "$W/fix-$FIX" "$R"; mkdir -p "$R/out" "$R/cache" "$R/tmp"
rm -rf /tmp/openclaw
. "$D/env.sh" "$R"; export PATH=$OC:$PATH TMPDIR=$R/tmp
HEAPFLAG=""; [ "$HEAP" = 16g ] && HEAPFLAG="--max-old-space-size=16384"
echo "case $TAG: $(openclaw --version 2>&1 | tail -1) fixture=$FIX heap=$HEAP start $(date -u +%T)" | tee "$R/out/summary.txt"
MOCK_LOG=$R/out/mock.jsonl setsid node "$D/mock.cjs" $MPORT > "$R/out/mock.out" 2>&1 < /dev/null &
if [ "${MIGRATE:-0}" = 1 ]; then
  mkdir -p "$R/out/doctor"; t0=$(date +%s)
  ( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out/doctor REPRO_ANYTITLE=1 NODE_OPTIONS="-r $D/preload-mem.cjs $HEAPFLAG"; /usr/bin/time -v openclaw doctor --fix --yes > "$R/out/doctor.log" 2> "$R/out/doctor.time" ); drc=$?
  echo "doctor --fix --yes rc=$drc in $(( $(date +%s)-t0 ))s maxRSS=$(grep -o 'Maximum resident set size (kbytes): [0-9]*' "$R/out/doctor.time" | awk '{print int($NF/1024)"MB"}')" | tee -a "$R/out/summary.txt"
  node "$D/summarize.cjs" "$R/out/doctor" | sed 's/^/  doctor /' | tee -a "$R/out/summary.txt"
  grep -E "out of memory|ERR_WORKER|FATAL|heap limit" "$R/out/doctor.log" "$R/out/doctor.time" | cut -c1-200 | head -5 | tee -a "$R/out/summary.txt"
fi
t0=$(date +%s)
( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out NODE_OPTIONS="-r $D/preload-mem.cjs $HEAPFLAG"; setsid bash -c 'openclaw gateway run; echo "launcher exit=$? at $(date -u +%T)" >> "$0/out/exit.txt"' "$R" > "$R/out/gateway.log" 2>&1 < /dev/null & echo $! > "$R/out/launcher.pid" )
ready=no; for i in $(seq 1 900); do curl -sf -o /dev/null http://127.0.0.1:$GPORT/readyz && { ready=yes; break; }; kill -0 $(cat $R/out/launcher.pid) 2>/dev/null || break; sleep 2; done
echo "readyz=$ready after $(( $(date +%s)-t0 ))s" | tee -a "$R/out/summary.txt"
gpid() { ss -ltnp 2>/dev/null | grep ":$GPORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
P0=$(gpid); echo "serving pid=$P0" | tee -a "$R/out/summary.txt"
sleep 20
turn() { local n=$1 msg=$2; local t1=$(date +%s)
  echo "{\"turn\":$n,\"start\":\"$(date -u +%FT%T.%3NZ)\"}" >> "$R/out/turns.jsonl"
  timeout 1500 openclaw agent --session-key agent:main:big -m "$msg" --json --timeout 1400 > "$R/out/turn$n.json" 2> "$R/out/turn$n.err"; local ec=$?
  echo "{\"turn\":$n,\"end\":\"$(date -u +%FT%T.%3NZ)\",\"exit\":$ec}" >> "$R/out/turns.jsonl"
  local st=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.status||j.result?.status||"?")+" "+String(j.summary||j.result?.summary||j.text||j.reply||"").slice(0,80).replace(/\s+/g," "))}catch(e){console.log("unparsed")}' "$R/out/turn$n.json")
  local P=$(gpid); echo "turn$n exit=$ec $(( $(date +%s)-t1 ))s status=[$st] err=[$(tail -c 160 "$R/out/turn$n.err" | tr '\n' ' ')] pid=$P same=$([ "$P" = "$P0" ] && echo yes || echo NO)" | tee -a "$R/out/summary.txt"
  [ -n "$P" ] || { echo "gateway not serving after turn$n" | tee -a "$R/out/summary.txt"; sleep 30; }
}
for n in $(seq 1 $TURNS); do turn $n "Turn $n: what is the repro state now?"; done
if [ "${COMPACT:-1}" = 1 ]; then
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.agents.defaults.compaction={mode:"safeguard",maxActiveTranscriptBytes:"1mb"};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$OPENCLAW_CONFIG_PATH"
  echo "compaction config written $(date -u +%T)" | tee -a "$R/out/summary.txt"; sleep 15
  turn $((TURNS+1)) "Turn $((TURNS+1)) (compaction): what is the repro state now?"
  for k in $(seq 1 ${POST:-1}); do turn $((TURNS+1+k)) "Turn $((TURNS+1+k)) (after compaction): what is the repro state now?"; done
fi
sleep 30
pkill -f openclaw-gateway; pkill -f 'openclaw gateway run'; pkill -f "mock.cjs $MPORT"; sleep 3
cat "$R/out/exit.txt" 2>/dev/null | tee -a "$R/out/summary.txt"
node "$D/summarize.cjs" "$R/out" | tee -a "$R/out/summary.txt"
cp -a /tmp/openclaw "$R/out/tmp-openclaw-logs" 2>/dev/null; rm -rf "$R/out/tmp-openclaw-logs/session-archive-read-cache"
echo "archive-read-cache: /tmp/openclaw=$(du -sh /tmp/openclaw/session-archive-read-cache 2>/dev/null | cut -f1) TMPDIR=$(du -sh $R/tmp/openclaw/session-archive-read-cache 2>/dev/null | cut -f1)" | tee -a "$R/out/summary.txt"
L="$R/out/gateway.log $(ls $R/tmp/openclaw/*.log /tmp/openclaw/*.log 2>/dev/null)"
for k in "ERR_WORKER_OUT_OF_MEMORY" "admission is closed" "out of memory" "Reached heap limit" "FATAL" "stale-lease" "SQLite worker exited" "compaction"; do echo "count[$k]=$(cat $L 2>/dev/null | grep -c "$k")"; done | tee -a "$R/out/summary.txt"
grep -hE "out of memory|ERR_WORKER_OUT_OF_MEMORY|admission is closed|FATAL|heap limit|Reached heap|worker exited" $L 2>/dev/null | cut -c1-260 | sed -E 's/[0-9]{4}-[0-9-]+T[0-9:.]+Z?//g' | sort | uniq -c | sort -rn | head -15 | tee -a "$R/out/summary.txt"
