#!/usr/bin/env bash
# usage: OC=<bin dir> FIX=<fixture> TAG=<name> W=<workdir> [MIGRATE=1] [HEAP=default|16g] [TURNS=20] bash run-pressure.sh
# Production-like pressure: TURNS consecutive turns on agent:main:big whose exec tool returns 300K chars
# (one cache-ttl checkpoint per turn), a co-tenant loop of sessions.list + chat.history every ~2 s during the turns,
# a concurrent turn on agent:main:second every 5th turn, then a gateway restart and a first turn on both sessions.
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd); R=$W/run-$TAG; GPORT=${GPORT:-19811}; MPORT=${MPORT:-19870}; TURNS=${TURNS:-20}; HEAP=${HEAP:-default}
pkill -f "mock.cjs $MPORT" 2>/dev/null; pkill -f openclaw-gateway 2>/dev/null; pkill -f 'openclaw gateway run' 2>/dev/null; sleep 2
rm -rf "$R"; cp -a "$W/fix-$FIX" "$R"; mkdir -p "$R/out" "$R/cache" "$R/tmp"; rm -rf /tmp/openclaw
. "$D/env.sh" "$R"; export PATH=$OC:$PATH TMPDIR=$R/tmp
HEAPFLAG=""; [ "$HEAP" = 16g ] && HEAPFLAG="--max-old-space-size=16384"
echo "pressure $TAG: $(openclaw --version 2>&1 | tail -1) fixture=$FIX heap=$HEAP turns=$TURNS start $(date -u +%T)" | tee "$R/out/summary.txt"
MOCK_TOOL_BYTES=300000 MOCK_LOG=$R/out/mock.jsonl setsid node "$D/mock.cjs" $MPORT > "$R/out/mock.out" 2>&1 < /dev/null &
if [ "${MIGRATE:-0}" = 1 ]; then t0=$(date +%s); mkdir -p "$R/out/doctor"; ( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out/doctor REPRO_ANYTITLE=1 NODE_OPTIONS="-r $D/preload-mem.cjs $HEAPFLAG"; openclaw doctor --fix --yes > "$R/out/doctor.log" 2>&1 ); echo "doctor rc=$? in $(( $(date +%s)-t0 ))s" | tee -a "$R/out/summary.txt"; fi
gpid() { ss -ltnp 2>/dev/null | grep ":$GPORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
boot() { local t0=$(date +%s)
  ( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out NODE_OPTIONS="-r $D/preload-mem.cjs $HEAPFLAG"; setsid bash -c 'openclaw gateway run; echo "launcher exit=$? at $(date -u +%T)" >> "$0/out/exit.txt"' "$R" >> "$R/out/gateway.log" 2>&1 < /dev/null & echo $! > "$R/out/launcher.pid" )
  local ready=no; for i in $(seq 1 900); do curl -sf -o /dev/null http://127.0.0.1:$GPORT/readyz && { ready=yes; break; }; kill -0 $(cat $R/out/launcher.pid) 2>/dev/null || break; sleep 1; done
  echo "boot$1 readyz=$ready after $(( $(date +%s)-t0 ))s pid=$(gpid) $(date -u +%T)" | tee -a "$R/out/summary.txt"; }
turn() { local n=$1 key=$2; local t1=$(date +%s%3N)
  timeout 1500 openclaw agent --session-key $key -m "Pressure turn $n on $key: run the check again." --json --timeout 1400 > "$R/out/turn-$n-$(basename $key).json" 2> "$R/out/turn-$n-$(basename $key).err"; local ec=$?
  echo "turn$n $key exit=$ec $(( $(date +%s%3N)-t1 ))ms err=[$(tail -c 140 "$R/out/turn-$n-$(basename $key).err" | tr '\n' ' ')] pid=$(gpid)" | tee -a "$R/out/summary.txt"; }
cotenant() { while [ -f "$R/out/cotenant.on" ]; do
  for m in "sessions.list|{\"limit\":50}" "chat.history|{\"sessionKey\":\"agent:main:big\",\"limit\":200}"; do local t1=$(date +%s%3N)
    timeout 60 openclaw gateway call "${m%%|*}" --params "${m#*|}" --json --timeout 30000 > /dev/null 2> "$R/out/cotenant.err"; local ec=$?
    echo "{\"t\":\"$(date -u +%T)\",\"m\":\"${m%%|*}\",\"exit\":$ec,\"ms\":$(( $(date +%s%3N)-t1 )),\"err\":\"$(tail -c 120 $R/out/cotenant.err | tr -d '\n\"\\' )\"}" >> "$R/out/cotenant.jsonl"; done; sleep 2; done; }
boot 1; sleep 15
touch "$R/out/cotenant.on"; cotenant & CT=$!
for n in $(seq 1 $TURNS); do
  SP=""; if [ $((n % 5)) = 0 ]; then turn $n agent:main:second & SP=$!; fi
  turn $n agent:main:big; [ -n "$SP" ] && wait $SP
done
rm -f "$R/out/cotenant.on"; wait $CT 2>/dev/null
echo "cotenant calls=$(wc -l < $R/out/cotenant.jsonl) failed=$(grep -vc '"exit":0' $R/out/cotenant.jsonl) maxMs=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);console.log(Math.max(...l.map(x=>x.ms)))' $R/out/cotenant.jsonl)" | tee -a "$R/out/summary.txt"
echo "restart: stopping gateway $(date -u +%T)" | tee -a "$R/out/summary.txt"; pkill -TERM -f openclaw-gateway; for i in $(seq 1 60); do [ -z "$(gpid)" ] && break; sleep 1; done; pkill -KILL -f openclaw-gateway 2>/dev/null; sleep 2
boot 2
turn $((TURNS+1)) agent:main:second & SP=$!; turn $((TURNS+1)) agent:main:big; wait $SP
turn $((TURNS+2)) agent:main:big
sleep 20
pkill -f openclaw-gateway; pkill -f 'openclaw gateway run'; pkill -f "mock.cjs $MPORT"; sleep 3
cat "$R/out/exit.txt" 2>/dev/null | tee -a "$R/out/summary.txt"
node "$D/summarize.cjs" "$R/out" | tee -a "$R/out/summary.txt"
L="$R/out/gateway.log $(ls $R/tmp/openclaw/*.log /tmp/openclaw/*.log 2>/dev/null)"
for k in "ERR_WORKER_OUT_OF_MEMORY" "admission is closed" "Reached heap limit" "rowTranscript.backfill" "stale-lease" "cache-ttl"; do echo "count[$k]=$(cat $L 2>/dev/null | grep -c "$k")"; done | tee -a "$R/out/summary.txt"
