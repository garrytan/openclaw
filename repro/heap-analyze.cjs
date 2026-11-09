"use strict";
// usage: node --max-old-space-size=40000 heap-analyze.cjs <file.heapsnapshot> [topN]
// Prints: totals, self size by constructor, biggest single objects, top retained objects (dominator tree) with
// a shortest retainer path from the root, and string totals grouped by the object/property that holds them.
const fs = require("node:fs");
const file = process.argv[2], TOP = Number(process.argv[3] || 25);
const t0 = Date.now();
const snap = JSON.parse(fs.readFileSync(file, "utf8"));
const m = snap.snapshot.meta, NF = m.node_fields.length, EF = m.edge_fields.length;
const nTypes = m.node_types[0], eTypes = m.edge_types[0];
const nT = m.node_fields.indexOf("type"), nN = m.node_fields.indexOf("name"), nS = m.node_fields.indexOf("self_size"), nE = m.node_fields.indexOf("edge_count"), nI = m.node_fields.indexOf("id");
const eT = m.edge_fields.indexOf("type"), eN = m.edge_fields.indexOf("name_or_index"), eTo = m.edge_fields.indexOf("to_node");
const nodes = snap.nodes, edges = snap.edges, strs = snap.strings;
const N = nodes.length / NF;
const first = new Uint32Array(N + 1);
for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += nodes[i * NF + nE] * EF; } first[N] = edges.length;
const typeOf = (i) => nTypes[nodes[i * NF + nT]], self = (i) => nodes[i * NF + nS];
const isStr = (t) => t === "string" || t === "concatenated string" || t === "sliced string";
const nameOf = (i) => { const t = typeOf(i), s = strs[nodes[i * NF + nN]]; if (isStr(t)) return JSON.stringify(String(s).slice(0, 70)) + "…(" + String(s).length + " chars)"; return t === "object" || t === "closure" || t === "native" ? s : "(" + t + ")" + (s ? " " + String(s).slice(0, 60) : ""); };
const weak = eTypes.indexOf("weak"), shortcut = eTypes.indexOf("shortcut");
const edgeName = (e) => { const t = eTypes[edges[e + eT]], v = edges[e + eN]; return t === "element" || t === "hidden" ? "[" + v + "]" : t === "context" ? "ctx." + strs[v] : String(strs[v]); };
let total = 0; for (let i = 0; i < N; i++) total += self(i);
console.log("file", file, "nodes", N, "edges", edges.length / EF, "selfTotalMB", (total / 1048576).toFixed(1), "parseS", ((Date.now() - t0) / 1000).toFixed(1));
// self size by constructor / type
const agg = new Map();
for (let i = 0; i < N; i++) { const t = typeOf(i); const k = isStr(t) ? "(" + t + ")" : t === "object" || t === "closure" ? strs[nodes[i * NF + nN]] : "(" + t + ")"; const a = agg.get(k) || [0, 0]; a[0] += self(i); a[1]++; agg.set(k, a); }
console.log("\n== self size by constructor (top " + TOP + ")");
for (const [k, [s, c]] of [...agg].sort((a, b) => b[1][0] - a[1][0]).slice(0, TOP)) console.log((s / 1048576).toFixed(1).padStart(9) + " MB " + String(c).padStart(9) + "  " + k);
// string size histogram
const bins = [[0, 1e3], [1e3, 1e4], [1e4, 1e5], [1e5, 1e6], [1e6, 1e12]].map((b) => ({ b, n: 0, s: 0 }));
for (let i = 0; i < N; i++) if (isStr(typeOf(i))) { const s = self(i); for (const x of bins) if (s >= x.b[0] && s < x.b[1]) { x.n++; x.s += s; } }
console.log("\n== string self-size bins"); for (const x of bins) console.log("  [" + x.b[0] + "," + x.b[1] + ") n=" + x.n + " MB=" + (x.s / 1048576).toFixed(1));
// BFS from root for shortest retainer paths (skip weak edges)
const par = new Int32Array(N).fill(-1), parE = new Int32Array(N).fill(-1); par[0] = 0;
{ const q = new Uint32Array(N); let h = 0, tl = 0; q[tl++] = 0; while (h < tl) { const i = q[h++]; for (let e = first[i]; e < first[i + 1]; e += EF) { const et = edges[e + eT]; if (et === weak) continue; const j = edges[e + eTo] / NF; if (par[j] === -1) { par[j] = i; parE[j] = e; q[tl++] = j; } } } }
const pathOf = (j, max = 14) => { const p = []; let k = j; while (k !== 0 && par[k] !== -1 && p.length < 40) { p.push(edgeName(parE[k]) + " -> " + nameOf(k).slice(0, 60)); k = par[k]; } p.reverse(); const pp = p.length > max ? [...p.slice(0, 4), "…", ...p.slice(-max + 4)] : p; return pp.join("\n        "); };
// dominators: Cooper-Harvey-Kennedy on reverse postorder of reachable graph (non-weak edges)
const post = new Int32Array(N).fill(-1), order = new Uint32Array(N); let pc = 0;
{ const st = new Uint32Array(N), it = new Uint32Array(N), seen = new Uint8Array(N); let sp = 0; st[sp] = 0; it[sp] = first[0]; sp++; seen[0] = 1;
  while (sp > 0) { const i = st[sp - 1]; let e = it[sp - 1]; let pushed = false;
    while (e < first[i + 1]) { const et = edges[e + eT]; const j = edges[e + eTo] / NF; e += EF; if (et === weak || seen[j]) continue; seen[j] = 1; it[sp - 1] = e; st[sp] = j; it[sp] = first[j]; sp++; pushed = true; break; }
    if (!pushed) { post[i] = pc; order[pc++] = i; sp--; } } }
// predecessor lists
const predCount = new Uint32Array(N + 1);
for (let i = 0; i < N; i++) if (post[i] >= 0) for (let e = first[i]; e < first[i + 1]; e += EF) { if (edges[e + eT] === weak) continue; predCount[edges[e + eTo] / NF + 1]++; }
for (let i = 0; i < N; i++) predCount[i + 1] += predCount[i];
const preds = new Uint32Array(predCount[N]); const fill = predCount.slice(0, N);
for (let i = 0; i < N; i++) if (post[i] >= 0) for (let e = first[i]; e < first[i + 1]; e += EF) { if (edges[e + eT] === weak) continue; const j = edges[e + eTo] / NF; preds[fill[j]++] = i; }
const idom = new Int32Array(N).fill(-1); idom[0] = 0;
const intersect = (a, b) => { while (a !== b) { while (post[a] < post[b]) a = idom[a]; while (post[b] < post[a]) b = idom[b]; } return a; };
for (let changed = true, pass = 0; changed && pass < 50; pass++) { changed = false;
  for (let k = pc - 1; k >= 0; k--) { const b = order[k]; if (b === 0) continue; let nd = -1;
    for (let p = predCount[b]; p < predCount[b + 1]; p++) { const q = preds[p]; if (idom[q] === -1) continue; nd = nd === -1 ? q : intersect(q, nd); }
    if (nd !== -1 && idom[b] !== nd) { idom[b] = nd; changed = true; } } }
const ret = new Float64Array(N); for (let i = 0; i < N; i++) ret[i] = post[i] >= 0 ? self(i) : 0;
for (let k = 0; k < pc; k++) { const b = order[k]; if (b !== 0 && idom[b] >= 0) ret[idom[b]] += ret[b]; }
console.log("\n== top retained objects (dominator tree), excluding synthetic roots");
const cand = []; for (let i = 1; i < N; i++) { const t = typeOf(i); if (t === "synthetic" || post[i] < 0) continue; if (ret[i] > 2 * 1048576) cand.push(i); }
cand.sort((a, b) => ret[b] - ret[a]);
const shown = [];
const shownAncestor = (i) => { let k = idom[i]; for (let d = 0; d < 30 && k > 0; d++) { const at = shown.indexOf(k); if (at >= 0) return at; k = idom[k]; } return -1; };
for (const i of cand.slice(0, 5000)) { const at = shownAncestor(i); if (at >= 0) { if (ret[i] >= 0.9 * ret[shown[at]]) shown[at] = i; continue; } if (shown.length < TOP) shown.push(i); }
for (const i of shown) { const chain = []; let k = idom[i]; for (let d = 0; d < 4 && k > 0; d++) { chain.push(nameOf(k).slice(0, 40) + "(" + (ret[k] / 1048576).toFixed(0) + "MB)"); k = idom[k]; }
  console.log("\n" + (ret[i] / 1048576).toFixed(1).padStart(8) + " MB retained, self " + (self(i) / 1024).toFixed(0) + " KB, " + nameOf(i) + " @" + nodes[i * NF + nI] + "  edges=" + (first[i + 1] - first[i]) / EF);
  console.log("   dominated by: " + chain.join(" <- "));
  console.log("   path: " + pathOf(i)); }
// biggest single objects
console.log("\n== biggest single objects (self size)");
const big = []; for (let i = 0; i < N; i++) if (self(i) > 256 * 1024) big.push(i); big.sort((a, b) => self(b) - self(a));
for (const i of big.slice(0, TOP)) console.log((self(i) / 1048576).toFixed(2).padStart(8) + " MB " + nameOf(i) + "\n   path: " + pathOf(i, 8));
// strings grouped by first non-string holder + edge
console.log("\n== string bytes grouped by holder (first non-string retainer on the BFS path) and edge name");
const g = new Map();
for (let i = 0; i < N; i++) { if (!isStr(typeOf(i)) || par[i] < 0) continue; let k = i, e = parE[i]; while (k !== 0 && isStr(typeOf(par[k]))) { k = par[k]; e = parE[k]; } const h = par[k]; const key = nameOf(h).slice(0, 50) + " ." + (eTypes[edges[e + eT]] === "element" ? "[i]" : edgeName(e)); const a = g.get(key) || [0, 0]; a[0] += self(i); a[1]++; g.set(key, a); }
for (const [k, [s, c]] of [...g].sort((a, b) => b[1][0] - a[1][0]).slice(0, TOP)) console.log((s / 1048576).toFixed(1).padStart(9) + " MB " + String(c).padStart(8) + "  " + k);
console.log("\nanalysisS", ((Date.now() - t0) / 1000).toFixed(1));
