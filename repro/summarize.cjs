"use strict";
const fs=require("node:fs"),path=require("node:path");const o=process.argv[2];
const rd=f=>{try{return fs.readFileSync(path.join(o,f),"utf8").trim().split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)}catch{return[]}};
const mem=rd("mem.jsonl"),wk=rd("workers.jsonl"),sn=rd("snaps.jsonl");const byPid={};
for(const m of mem){const p=byPid[m.pid]||(byPid[m.pid]={pid:m.pid,title:m.title,n:0,rss:0,heap:0,wMax:0,wSum:0,first:m.t,last:m.t});p.n++;p.rss=Math.max(p.rss,m.rss);p.heap=Math.max(p.heap,m.heapUsed);p.wMax=Math.max(p.wMax,m.wMax);p.wSum=Math.max(p.wSum,m.wSum);p.last=m.t}
const peaks={};for(const w of wk){if(w.peakMB!=null){peaks[w.id]=Math.max(peaks[w.id]||0,w.peakMB)}}
for(const m of mem)for(const t of m.top||[])peaks[t.id]=Math.max(peaks[t.id]||0,t.used);
const spawns=wk.filter(w=>w.ev==="spawn");const sp=id=>spawns.find(s=>s.id===id)||{};
const names={};for(const s of spawns){names[s.name]=(names[s.name]||0)+1}
const top=Object.entries(peaks).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id,v])=>"w"+id+"(tid "+sp(+id).threadId+" "+String(sp(+id).name).split("/").pop()+")="+v+"MB");
const errs=wk.filter(w=>w.ev==="error");const oom=errs.filter(e=>/OUT_OF_MEMORY|heap out of memory/i.test(e.code+" "+e.msg));
const exits=wk.filter(w=>w.ev==="exit"&&w.code!==0);
console.log("processes:",JSON.stringify(Object.values(byPid).map(p=>({pid:p.pid,title:p.title,samples:p.n,peakRssMB:p.rss,peakMainHeapMB:p.heap,peakOneWorkerMB:p.wMax,peakAllWorkersMB:p.wSum,from:p.first,to:p.last}))));
console.log("workers spawned="+spawns.length+" errors="+errs.length+" workerOOM="+oom.length+" nonzeroExits="+exits.length+" respawnedNames="+Object.entries(names).filter(([,c])=>c>1).map(([n,c])=>String(n).split("/").pop()+"x"+c).join(","));
console.log("topWorkerPeaks: "+top.join(" "));
const fmt=i=>(i||[]).map(x=>[x.type,x.cmd,x.in_kind,x.req_kind,x.in_limits].filter(Boolean).join("/")).join(" | ");
for(const e of oom.slice(0,8))console.log("  OOM",e.t,"w"+e.id,"tid",e.threadId,String(e.name).split("/").pop(),e.code,"peak",e.peakMB+"MB","inflight:",fmt(e.inflight));
for(const e of wk.filter(w=>w.ev==="level"&&w.levelMB>=350))console.log("  LEVEL",e.t,"w"+e.id,"tid",e.threadId,String(e.name).split("/").pop(),e.levelMB+"MB","inflight:",fmt(e.inflight));
for(const e of wk.filter(w=>w.ev==="threshold"))console.log("  THRESH",e.t,"w"+e.id,"tid",e.threadId,String(e.name).split("/").pop(),e.thresholdMB+"MB","inflight:",fmt(e.inflight));
for(const e of sn.filter(s=>s.ev!=="start"))console.log("  SNAP",e.ev,e.t,"w"+e.id,e.threshold,e.file?path.basename(e.file):"",e.bytes||"",e.ms+"ms",e.msg||"");
