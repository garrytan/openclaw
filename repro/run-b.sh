#!/usr/bin/env bash
# follow-up: compaction-turn case with an optional pre-boot config change, post-compaction turns,
# then a gateway restart, one turn, and an idle window to catch the startup session catch-up.
# usage: OC=<bin dir> FIX=<fixture> TAG=<name> W=<workdir> [MIGRATE=1] [TURNS=3] [POST=3] [CFG='<js on c>'] [COMPACT_EXTRA='{"postIndexSync":"off"}'] [RESTART=1] [IDLE=120] bash run-b.sh
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd); R=$W/run-$TAG; GPORT=${GPORT:-19811}; MPORT=${MPORT:-19870}; TURNS=${TURNS:-3}; POST=${POST:-3}
pkill -f "[m]ock.cjs $MPORT"; pkill -f "[o]penclaw-gateway"; pkill -f "[o]penclaw gateway run"; sleep 2
rm -rf "$R"; cp -a "$W/fix-$FIX" "$R"; mkdir -p "$R/out" "$R/cache" "$R/tmp"
. "$D/env.sh" "$R"; export PATH=$OC:$PATH TMPDIR=$R/tmp REPRO_SNAP_MB=${REPRO_SNAP_MB:-9999}
echo "case-b $TAG: $(openclaw --version 2>&1 | tail -1) fixture=$FIX cfg=[${CFG:-}] compactExtra=[${COMPACT_EXTRA:-}] start $(date -u +%T)" | tee "$R/out/summary.txt"
MOCK_LOG=$R/out/mock.jsonl setsid node "$D/mock.cjs" $MPORT > "$R/out/mock.out" 2>&1 < /dev/null &
if [ "${MIGRATE:-0}" = 1 ]; then t0=$(date +%s); mkdir -p "$R/out/doctor"; ( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out/doctor REPRO_ANYTITLE=1 NODE_OPTIONS="-r $D/preload-mem.cjs"; openclaw doctor --fix --yes > "$R/out/doctor.log" 2>&1 ); echo "doctor rc=$? in $(( $(date +%s)-t0 ))s" | tee -a "$R/out/summary.txt"; fi
if [ -n "${CFG:-}" ]; then CFG="$CFG" node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));eval(process.env.CFG);fs.writeFileSync(f,JSON.stringify(c,null,2))' "$OPENCLAW_CONFIG_PATH" && echo "cfg applied: $CFG" | tee -a "$R/out/summary.txt"; fi
if [ -n "${CFG:-}" ] || [ "${MIGRATE:-0}" = 1 ]; then openclaw config validate > "$R/out/validate.log" 2>&1; echo "config validate rc=$? $(tail -c 200 $R/out/validate.log | tr '\n' ' ')" | tee -a "$R/out/summary.txt"; fi
gpid() { ss -ltnp 2>/dev/null | grep ":$GPORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
boot() { local t0=$(date +%s)
  ( export NODE_COMPILE_CACHE=$R/cache REPRO_OUT=$R/out NODE_OPTIONS="-r $D/preload-mem.cjs"; setsid bash -c 'openclaw gateway run; echo "launcher exit=$? at $(date -u +%T)" >> "$0/out/exit.txt"' "$R" >> "$R/out/gateway.log" 2>&1 < /dev/null & )
  local ready=no; for i in $(seq 1 600); do curl -sf -o /dev/null http://127.0.0.1:$GPORT/readyz && { ready=yes; break; }; sleep 1; done
  echo "boot$1 readyz=$ready after $(( $(date +%s)-t0 ))s pid=$(gpid) $(date -u +%T)" | tee -a "$R/out/summary.txt"; }
turn() { local n=$1; local t1=$(date +%s)
  timeout 900 openclaw agent --session-key agent:main:big -m "$2" --json --timeout 800 > "$R/out/turn-$n.json" 2> "$R/out/turn-$n.err"; local ec=$?
  echo "turn$n exit=$ec $(( $(date +%s)-t1 ))s err=[$(tail -c 140 "$R/out/turn-$n.err" | tr '\n' ' ')] pid=$(gpid) $(date -u +%T)" | tee -a "$R/out/summary.txt"; }
boot 1; sleep 15
for n in $(seq 1 $TURNS); do turn $n "Turn $n: what is the repro state now?"; done
COMPACT_EXTRA="${COMPACT_EXTRA:-}" node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.agents.defaults.compaction={mode:"safeguard",maxActiveTranscriptBytes:"1mb",...JSON.parse(process.env.COMPACT_EXTRA||"{}")};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$OPENCLAW_CONFIG_PATH"
echo "compaction config written $(date -u +%T): $(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents.defaults.compaction))' "$OPENCLAW_CONFIG_PATH")" | tee -a "$R/out/summary.txt"; sleep 15
turn $((TURNS+1)) "Turn $((TURNS+1)) (compaction): what is the repro state now?"
for k in $(seq 1 $POST); do sleep 10; turn $((TURNS+1+k)) "Turn $((TURNS+1+k)) (after compaction): what is the repro state now?"; done
sleep 30
if [ "${RESTART:-1}" = 1 ]; then
  echo "restart: stopping gateway $(date -u +%T) pid=$(gpid)" | tee -a "$R/out/summary.txt"; pkill -TERM -f "[o]penclaw-gateway"; for i in $(seq 1 60); do pgrep -f "[o]penclaw-gateway" > /dev/null || break; sleep 1; done; pkill -KILL -f "[o]penclaw-gateway"; sleep 2
  echo "gateway-log-line-mark restart $(date -u +%T)" >> "$R/out/gateway.log"
  boot 2; turn $((TURNS+POST+2)) "Turn after restart: what is the repro state now?"
  sleep ${IDLE:-120}
fi
echo "end $(date -u +%T) gatewayAlive=$([ -n "$(gpid)" ] && echo yes || echo NO)" | tee -a "$R/out/summary.txt"
pkill -f "[o]penclaw-gateway"; pkill -f "[o]penclaw gateway run"; pkill -f "[m]ock.cjs $MPORT"; sleep 3
cat "$R/out/exit.txt" 2>/dev/null | tee -a "$R/out/summary.txt"
node "$D/summarize.cjs" "$R/out" | tee -a "$R/out/summary.txt"
L="$R/out/gateway.log $(ls $R/tmp/openclaw/*.log 2>/dev/null)"
for k in "ERR_WORKER_OUT_OF_MEMORY" "Reached heap limit" "session transcript export snapshot" "memory sync" "post-compaction" "catch-up\|catchup\|catch up"; do echo "count[$k]=$(cat $L 2>/dev/null | grep -c "$k")"; done | tee -a "$R/out/summary.txt"
grep -c '"session-entr' "$R/out/workers.jsonl" 2>/dev/null | sed 's/^/workers.jsonl session-entr* lines=/' | tee -a "$R/out/summary.txt"
