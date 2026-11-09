"use strict";
// Gateway memory probe.
// - main-isolate heap + process RSS every second, every worker thread's heap via worker.getHeapStatistics();
//   polling drops to 200 ms while any worker is above REPRO_FAST_MB (default 200).
// - per worker: a ring of the last posted requests (command type / task kind only, never payloads), logged on
//   threshold crossings, errors and exits, so the op in flight at a worker death is on record.
// - heap snapshots: when a worker's used heap passes each REPRO_SNAP_MB threshold (default 380,480), stream
//   worker.getHeapSnapshot() to $REPRO_OUT/snap-w<id>-<mb>.heapsnapshot (at most REPRO_SNAP_MAX per process).
const fs = require("node:fs"), path = require("node:path"), wt = require("node:worker_threads"), mod = require("node:module"), v8 = require("node:v8");
const OUT = process.env.REPRO_OUT;
if (OUT && wt.isMainThread && !globalThis.__reproMem) {
  globalThis.__reproMem = true;
  const log = (f, o) => { try { fs.appendFileSync(path.join(OUT, f), JSON.stringify(o) + "\n"); } catch {} };
  const now = () => new Date().toISOString();
  const SNAP = (process.env.REPRO_SNAP_MB || "380,480").split(",").map(Number).filter(Boolean).sort((a, b) => a - b);
  const SNAP_MAX = Number(process.env.REPRO_SNAP_MAX || 6);
  const LOGMB = (process.env.REPRO_LOG_MB || "250,350,450,520").split(",").map(Number).filter(Boolean);
  const FAST_MB = Number(process.env.REPRO_FAST_MB || 200);
  let snapsTaken = 0;
  const short = (v) => (typeof v === "string" ? v.slice(0, 80) : undefined);
  const pick = (o, pre, d) => { if (!o || typeof o !== "object") return; for (const k of ["kind", "type", "mode", "caller", "purpose"]) if (short(o[k])) d[pre + k] = short(o[k]); if (o.limits && typeof o.limits === "object") d[pre + "limits"] = Object.keys(o.limits).slice(0, 10).join(",") + (o.limits.compaction ? ":compaction" : ""); };
  const describe = (msg) => {
    if (!msg || typeof msg !== "object") return { t: typeof msg };
    const d = {};
    for (const k of ["type", "kind", "status", "op", "operation", "task", "method", "requestClass"]) if (short(msg[k])) d[k] = short(msg[k]);
    if (msg.taskId !== undefined) d.taskId = msg.taskId;
    const inp = msg.input;
    if (inp instanceof Uint8Array) {
      d.inputBytes = inp.byteLength;
      if (inp.byteLength <= 2 * 1048576) {
        try { const c = v8.deserialize(Buffer.from(inp.buffer, inp.byteOffset, inp.byteLength)); if (c && typeof c === "object") { d.cmd = short(c.type) || short(c.kind); pick(c.input, "in_", d); } } catch {}
      }
    } else if (inp && typeof inp === "object") { pick(inp, "in_", d); pick(inp.request, "req_", d); }
    if (msg.transfer && typeof msg.transfer === "object") d.transfer = true;
    return d;
  };
  const Orig = wt.Worker; const workers = new Map(); let seq = 0;
  class Tracked extends Orig {
    constructor(file, opts) {
      super(file, opts);
      const id = ++seq;
      const name = String((opts && opts.name) || file).split("/").slice(-2).join("/").slice(0, 120);
      const rec = { id, name, limit: (opts && opts.resourceLimits) || null, peak: 0, born: Date.now(), pid: process.pid, threadId: this.threadId, ring: [], posts: 0, snaps: new Set(), last: 0 };
      workers.set(this, rec);
      log("workers.jsonl", { ev: "spawn", t: now(), id, name, threadId: this.threadId, limit: rec.limit, pid: process.pid });
      const post = this.postMessage.bind(this);
      this.postMessage = (msg, transfer) => {
        try { rec.posts++; const d = describe(msg); d.at = now(); d.n = rec.posts; rec.ring.push(d); if (rec.ring.length > 8) rec.ring.shift(); if (rec.posts <= 3 || process.env.REPRO_LOG_POSTS) log("posts.jsonl", { id, name, ...d }); } catch {}
        return post(msg, transfer);
      };
      this.on("error", (e) => log("workers.jsonl", { ev: "error", t: now(), id, name, threadId: rec.threadId, code: e && e.code, msg: String(e && e.message).slice(0, 300), peakMB: Math.round(rec.peak / 1048576), lastMB: rec.last, inflight: rec.ring.slice(-4) }));
      this.on("exit", (c) => { log("workers.jsonl", { ev: "exit", t: now(), id, name, threadId: rec.threadId, code: c, peakMB: Math.round(rec.peak / 1048576), lastMB: rec.last, lifeS: Math.round((Date.now() - rec.born) / 1000), posts: rec.posts, inflight: rec.ring.slice(-4) }); workers.delete(this); });
    }
  }
  wt.Worker = Tracked; mod.syncBuiltinESMExports();
  const snapshot = async (w, r, mb) => {
    if (snapsTaken >= SNAP_MAX) return; snapsTaken++;
    const file = path.join(OUT, "snap-w" + r.id + "-" + mb + ".heapsnapshot"); const t0 = Date.now();
    log("snaps.jsonl", { ev: "start", t: now(), id: r.id, name: r.name, threadId: r.threadId, threshold: mb, usedMB: r.last, inflight: r.ring.slice(-4), mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
    try {
      const s = await w.getHeapSnapshot();
      await new Promise((res, rej) => { const o = fs.createWriteStream(file); s.pipe(o); o.on("finish", res); o.on("error", rej); s.on("error", rej); });
      log("snaps.jsonl", { ev: "done", t: now(), id: r.id, threshold: mb, file, bytes: fs.statSync(file).size, ms: Date.now() - t0 });
    } catch (e) { log("snaps.jsonl", { ev: "fail", t: now(), id: r.id, threshold: mb, msg: String(e && e.message).slice(0, 200), ms: Date.now() - t0 }); }
  };
  let fast = false, busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      if (!/openclaw-gateway|gateway/.test(process.title) && !process.env.REPRO_ANYTITLE) return;
      const mu = process.memoryUsage(); const ws = [];
      await Promise.all([...workers.entries()].map(async ([w, r]) => {
        try {
          const h = await w.getHeapStatistics(); const mb = Math.round(h.used_heap_size / 1048576);
          r.peak = Math.max(r.peak, h.used_heap_size); r.last = mb;
          ws.push({ id: r.id, used: mb, lim: Math.round(h.heap_size_limit / 1048576), ext: Math.round((h.external_memory || 0) / 1048576) });
          for (const th of LOGMB) if (mb >= th && !r.snaps.has("log" + th)) { r.snaps.add("log" + th); log("workers.jsonl", { ev: "level", t: now(), id: r.id, name: r.name, threadId: r.threadId, levelMB: th, usedMB: mb, inflight: r.ring.slice(-4) }); }
          for (const th of SNAP) if (mb >= th && !r.snaps.has(th)) { r.snaps.add(th); log("workers.jsonl", { ev: "threshold", t: now(), id: r.id, name: r.name, threadId: r.threadId, thresholdMB: th, usedMB: mb, inflight: r.ring.slice(-4) }); snapshot(w, r, th); break; }
        } catch {}
      }));
      const wMax = ws.reduce((a, b) => Math.max(a, b.used), 0);
      fast = wMax >= FAST_MB;
      log("mem.jsonl", { t: now(), pid: process.pid, title: process.title, rss: Math.round(mu.rss / 1048576), heapUsed: Math.round(mu.heapUsed / 1048576), ext: Math.round(mu.external / 1048576), ab: Math.round(mu.arrayBuffers / 1048576), nW: ws.length, wMax, wSum: ws.reduce((a, b) => a + b.used, 0), top: ws.sort((a, b) => b.used - a.used).slice(0, 3) });
    } finally { busy = false; }
  };
  let lastSlow = 0;
  const loop = setInterval(() => { const n = Date.now(); if (fast || n - lastSlow >= 1000) { lastSlow = n; tick(); } }, 200); loop.unref();
  process.on("exit", () => { for (const r of workers.values()) log("workers.jsonl", { ev: "final", id: r.id, name: r.name, threadId: r.threadId, peakMB: Math.round(r.peak / 1048576), posts: r.posts }); });
}
