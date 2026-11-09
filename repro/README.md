# Large-session memory repro for OpenClaw

Scripts that reproduce OpenClaw's large-session worker memory failures on an isolated Gateway with a mock model. They were used for the evidence in the linked issue and PR. Nothing here talks to a real model or service.

## Files
- seed.cjs: writes legacy JSONL sessions. `realistic` is a long-lived group chat (one 33,316-event / ~496 MB session plus a 206 MB one and 20 x 5 MB), heavy-tailed tool results, a compaction every 150 turns. `nocompact` is the same with no compactions. `flood` is 12,460 x 15 KB assistant messages. SEED_SCALE multiplies sizes; SEED_FINAL_CHARS fixes the final assistant text per turn.
- make-fixture.sh: seeds, then imports with `openclaw doctor --session-sqlite import --session-sqlite-all-agents` (run it with 2026.10.9 for a legacy import).
- run-case.sh: copies the fixture, optionally migrates (MIGRATE=1 runs `doctor --fix --yes`), boots `gateway run` with the preload, runs TURNS agent turns, and with COMPACT=1 hot-reloads a safeguard compaction config and runs the compaction turn plus POST more turns.
- run-b.sh: the memory-index export case (flood or a set text share).
- run-pressure.sh: 20 turns with 300K-character tool results, co-tenant sessions.list/chat.history reads, a second session's turn every 5th turn, then a restart.
- preload-mem.cjs: `-r` preload that samples main and per-worker heap every second, logs the last requests posted to each worker, and writes worker heap snapshots at REPRO_SNAP_MB thresholds.
- mock.cjs: OpenAI-compatible mock (one exec tool call, then final text; also serves the summary model).
- heap-analyze.cjs, summarize.cjs, collect.cjs, active-window.cjs: analysis helpers.
- build-src.sh: builds OpenClaw from source and packs it like a release (`node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog`), optionally on a merged PR tree.

## Quick start
```bash
OC=<dir with openclaw on it> FIX=flood W=$HOME/repro bash make-fixture.sh
OC=<bin> FIX=flood TAG=flood-main W=$HOME/repro MIGRATE=1 COMPACT=1 POST=2 HEAP=default bash run-case.sh
```
Runs used Ubuntu 24.04, Node 24.22.1, 16 vCPU / 62 GB. All seeded text is ASCII.
