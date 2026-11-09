#!/usr/bin/env bash
# usage: bash build-src.sh <name> <base-sha> [merge-ref]
# Builds OpenClaw from source like a release package and installs it into ~/oc/<name>.
set -euo pipefail
export PATH=$HOME/node-v24.22.1-linux-x64/bin:$PATH
NAME=$1 BASE=$2 MERGE=${3:-}
command -v pnpm >/dev/null || npm i -g --no-audit --no-fund pnpm@12.15.0 >/dev/null
S=$HOME/src/$NAME; P=$HOME/pkgs/$NAME; mkdir -p $HOME/src $P
t0=$(date +%s)
[ -d $S ] || git -C $HOME/openclaw worktree add --detach $S $BASE
cd $S
if [ -n "$MERGE" ]; then T=$(git merge-tree --write-tree HEAD $MERGE) || { echo "merge conflict: $T"; exit 1; }; git read-tree -u --reset "$T"; echo "merged tree $T (git merge-tree; no commit)"; fi
echo "base=$(git rev-parse HEAD) merge=${MERGE:+$(git rev-parse $MERGE)} tree=$(git write-tree)"
echo "pnpm $(pnpm --version) node $(node --version)"
t1=$(date +%s); pnpm install --frozen-lockfile > $P/install.log 2>&1; echo "pnpm install: $(( $(date +%s)-t1 ))s"
t1=$(date +%s); node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog --output-dir $P > $P/pack.log 2>&1; echo "package-openclaw-for-docker (pnpm run build + pack): $(( $(date +%s)-t1 ))s"
ls -la $P/*.tgz
mkdir -p $HOME/oc/$NAME && cd $HOME/oc/$NAME && { [ -f package.json ] || npm init -y >/dev/null; }
t1=$(date +%s); npm i --no-audit --no-fund $P/*.tgz > install.log 2>&1; echo "npm i tgz: $(( $(date +%s)-t1 ))s"
./node_modules/.bin/openclaw --version
echo "total $(( $(date +%s)-t0 ))s"
