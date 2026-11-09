"use strict";
// Collect one row per run dir under ~/w/run-*: turns, worker peaks, OOMs, respawns, heap/RSS peaks, ops in flight.
const fs=require("fs"),path=require("path");const W=path.join(process.env.HOME,"w");
const rd=(d,f)=>{try{return fs.readFileSync(path.join(d,f),"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)}catch{return[]}};
const rows=[];
for(const dir of fs.readdirSync(W).filter(d=>d.startsWith("run-")).sort()){const o=path.join(W,dir,"out");if(!fs.existsSync(o))continue;
 const sum=fs.readFileSync(path.join(o,"summary.txt"),"utf8");const mem=rd(o,"mem.jsonl"),wk=rd(o,"workers.jsonl");
 const gw=mem.filter(m=>/gateway/.test(m.title));const pid=gw.length?gw[gw.length-1].pid:null;
 const turns=[...sum.matchAll(/^turn(\d+) exit=(\d+) (\d+)s status=\[([^\]]*)\]/gm)].map(m=>"t"+m[1]+":"+(m[2]==="0"?"ok":"FAIL")+"/"+m[3]+"s");
 const peaks={};for(const m of gw)for(const t of m.top||[])peaks[t.id]=Math.max(peaks[t.id]||0,t.used);for(const w of wk)if(w.peakMB!=null&&w.pid!==undefined)peaks[w.id]=Math.max(peaks[w.id]||0,w.peakMB);
 const spawn=wk.filter(w=>w.ev==="spawn"&&(pid==null||w.pid===pid));const sp=id=>spawn.find(s=>s.id===+id)||{};
 const top=Object.entries(peaks).filter(([id])=>sp(id).name).sort((a,b)=>b[1]-a[1])[0]||[];
 const oom=wk.filter(w=>w.ev==="error"&&/OUT_OF_MEMORY/.test(w.code+" "+w.msg));
 const cnt=k=>{const m=sum.match(new RegExp("count\\["+k+"\\]=(\\d+)"));return m?+m[1]:null};
 const respawn=n=>spawn.filter(s=>String(s.name).endsWith(n)).length;
 const fmt=i=>(i||[]).slice(-1).map(x=>[x.cmd,x.in_kind,x.req_kind,x.in_limits].filter(Boolean).join("/")).join("");
 const lv=wk.filter(w=>(w.ev==="level"||w.ev==="threshold")&&+w.id===+top[0]).sort((a,b)=>(b.levelMB||b.thresholdMB)-(a.levelMB||a.thresholdMB))[0];
 const exit=(sum.match(/launcher exit=(\d+)/)||[])[1];
 rows.push({run:dir.slice(4),version:(sum.match(/OpenClaw ([^ ]+ \([0-9a-f]+\))/)||[])[1],doctor:(sum.match(/doctor --fix --yes rc=(\d+) in (\d+)s/)||[]).slice(1).join("/"),turns:turns.join(" "),
  peakWorker:top.length?top[1]+"MB w"+top[0]+" tid"+sp(top[0]).threadId+" "+String(sp(top[0]).name).split("/").pop():"",
  opAtPeak:oom.length?fmt(oom[0].inflight):lv?fmt(lv.inflight):"",workerOOM:Math.max(oom.length,cnt("ERR_WORKER_OUT_OF_MEMORY")||0),fatal:cnt("Reached heap limit"),admissionClosed:cnt("admission is closed"),
  respawns:"st="+respawn("session-transcript.worker.js")+" sq="+respawn("sqlite-store.worker.js"),mainHeapPeakMB:Math.max(0,...gw.map(m=>m.heapUsed)),rssPeakMB:Math.max(0,...gw.map(m=>m.rss)),gatewayExit:exit||"",
  archiveCache:(sum.match(/archive-read-cache: (.*)/)||[])[1]});
}
fs.writeFileSync(path.join(process.env.HOME,"rows.json"),JSON.stringify(rows,null,1));
for(const r of rows)console.log(JSON.stringify(r));
