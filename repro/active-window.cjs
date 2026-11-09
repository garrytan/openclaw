const fs=require("fs"),path=require("path");
for (const fx of process.argv.slice(2)) { const d=path.join(process.env.HOME,"w","fix-"+fx,"state/agents/main/sessions");
  let files=[];try{files=fs.readdirSync(d,{recursive:true}).filter(f=>String(f).endsWith(".jsonl")).map(f=>path.join(d,f))}catch(e){console.log(fx,"no dir");continue}
  files.sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size); const f=files[0]; if(!f){console.log(fx,"no jsonl");continue}
  const lines=fs.readFileSync(f,"utf8").split("\n").filter(Boolean); let lastC=-1,kept=null,compactions=0;
  lines.forEach((l,i)=>{if(l.includes('"type":"compaction"')){compactions++;lastC=i;kept=JSON.parse(l).firstKeptEntryId}});
  let start=0; if(kept){start=lines.findIndex(l=>l.includes('"id":"'+kept+'"'))}
  const act=lines.slice(start); const bytes=act.reduce((a,l)=>a+l.length+1,0);
  console.log(JSON.stringify({fixture:fx,file:path.basename(f),events:lines.length,MB:+(fs.statSync(f).size/1048576).toFixed(1),compactions,activeEvents:act.length,activeMB:+(bytes/1048576).toFixed(1)}));
}