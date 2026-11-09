"use strict";
// usage: node seed.cjs <mode realistic|flood> <stateDir> <workspace>
// realistic: long-lived group chat shape: one 33,316-event / ~496 MB session (agent:main:big),
//   one ~206 MB session, 20 x ~5 MB sessions. Mixed user / assistant+toolCall / toolResult / final, a compaction every 150 turns.
// flood: the chat.inject flood shape: one session of 12,460 assistant text messages of 15 KB (chat.inject-like), ~190 MB.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const [mode,stateDir,cwd]=process.argv.slice(2);
const dir=path.join(stateDir,"agents/main/sessions");fs.mkdirSync(dir,{recursive:true});
let seedN=1;const prng=()=>{seedN=(seedN*1103515245+12345)%2147483648;return seedN/2147483648};
const words="the of and to in a is that for on with as was it by at be this from or have an are not but had his they you were her she which their will all one would there what so up out if about who get go me when make can like time no just him know take into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us".split(" ");
const text=n=>{let s="";while(s.length<n)s+=words[Math.floor(prng()*words.length)]+(prng()<0.08?". ":" ");return s.slice(0,n)};
const blob=n=>crypto.randomBytes(Math.ceil(n*3/4)).toString("base64").slice(0,n);
const usage={input:1000,output:200,cacheRead:0,cacheWrite:0,totalTokens:1200,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const tools=["exec","read","web_fetch","write","exec","exec","read","memory_search"];
const store={};
const SCALE=Number(process.env.SEED_SCALE||1);
// follow-up: SEED_FINAL_CHARS fixes each turn's final assistant text length (default 300..2800 chars).
const FINAL_CHARS=Number(process.env.SEED_FINAL_CHARS||0);
// mode nocompact = the realistic shape with no compaction entries (the whole session is the active window);
// SEED_COMPACT_UNTIL (0..1) stops compacting after that fraction of each session's events.
const COMPACT_EVERY=mode==="nocompact"?0:Number(process.env.SEED_COMPACT_EVERY||150);
const COMPACT_UNTIL=Number(process.env.SEED_COMPACT_UNTIL||1);
function session(key,{events:ev,mb:mb0,shape}){const targetEvents=Math.max(50,Math.round(ev*SCALE)),mb=(mb0||0)*SCALE;
  const sid=crypto.randomUUID();const file=path.join(dir,sid+".jsonl");const fd=fs.openSync(file,"w");
  let t=Date.parse("2026-10-26T00:00:00Z");const ts=()=>new Date(t+=20000).toISOString();const id=()=>crypto.randomBytes(4).toString("hex");
  let parent=null,bytes=0,events=0,textBytes=0;const target=mb*1048576;const userIds=[];
  const w=o=>{if(o.type==="message"&&(o.message.role==="user"||o.message.role==="assistant"))for(const c of o.message.content)textBytes+=(c.text||c.thinking||"").length;o.parentId=parent;o.id=o.id||id();o.timestamp=ts();const s=JSON.stringify(o)+"\n";fs.writeSync(fd,s);bytes+=s.length;events++;parent=o.id;return o.id};
  const h={type:"session",version:3,id:sid,timestamp:ts(),cwd};const hs=JSON.stringify(h)+"\n";fs.writeSync(fd,hs);bytes+=hs.length;events++;
  if(shape==="flood"){
    w({type:"message",message:{role:"user",content:[{type:"text",text:"Start of the flood session."}],timestamp:t}});
    while(events<targetEvents) w({type:"message",message:{role:"assistant",content:[{type:"text",text:text(15000)}],api:"openai-completions",provider:"openclaw",model:"gateway-injected",usage,stopReason:"stop",timestamp:t}});
  } else {
    let turn=0;
    while(events<targetEvents-1){turn++;
      userIds.push(w({type:"message",message:{role:"user",content:[{type:"text",text:"[Telegram user] "+text(150+Math.floor(prng()*1800))}],timestamp:t}}));
      const calls=Math.floor(prng()*5);
      for(let k=0;k<calls&&events<targetEvents-2;k++){const cid="toolu_"+turn+"_"+k;const tool=tools[Math.floor(prng()*tools.length)];
        w({type:"message",message:{role:"assistant",content:[{type:"thinking",thinking:text(200+Math.floor(prng()*800))},{type:"text",text:text(100+Math.floor(prng()*300))},{type:"toolCall",id:cid,name:tool,arguments:{command:"cat ops/notes/"+turn+"-"+k+".md"}}],api:"openai-completions",provider:"fixture",model:"fixture",usage,stopReason:"toolUse",timestamp:t}});
        const remainEv=Math.max(1,(targetEvents-events)), remainBytes=Math.max(2000,target-bytes);
        const mean=Math.max(500,Math.min(400000,(remainBytes/remainEv)*2.6));
        const u=prng();const sz=Math.floor(Math.min(600000,Math.max(80,mean*(u<0.55?0.12:u<0.85?0.9:u<0.97?3.2:7))));
        w({type:"message",message:{role:"toolResult",toolCallId:cid,toolName:tool,content:[{type:"text",text:prng()<0.7?text(sz):blob(sz)}],isError:prng()<0.03,timestamp:t}});
      }
      w({type:"message",message:{role:"assistant",content:[{type:"text",text:text(FINAL_CHARS>0?FINAL_CHARS:300+Math.floor(prng()*2500))}],api:"openai-completions",provider:"fixture",model:"fixture",usage,stopReason:"stop",timestamp:t}});
      if(COMPACT_EVERY>0&&turn%COMPACT_EVERY===0&&userIds.length>20&&events<targetEvents*COMPACT_UNTIL) w({type:"compaction",summary:"## Goal\n"+text(6000),firstKeptEntryId:userIds[userIds.length-20],tokensBefore:600000,tokensAfter:90000});
    }
  }
  fs.closeSync(fd);
  store[key]={sessionId:sid,updatedAt:t,sessionFile:file,chatType:shape==="flood"?"direct":"group"};
  return {key,events,MB:+(bytes/1048576).toFixed(1),textMB:+(textBytes/1048576).toFixed(1)};
}
const out=[];
if(mode==="flood") out.push(session("agent:main:big",{events:12460,shape:"flood"}));
else { out.push(session("agent:main:big",{events:33316,mb:496,shape:"realistic"}));
  out.push(session("agent:main:second",{events:13800,mb:206,shape:"realistic"}));
  for(let i=0;i<20;i++) out.push(session("agent:main:small-"+i,{events:400,mb:5,shape:"realistic"})); }
fs.writeFileSync(path.join(dir,"sessions.json"),JSON.stringify(store,null,1));
console.log(JSON.stringify(out.slice(0,3)),"sessions="+out.length,"totalMB="+out.reduce((a,b)=>a+b.MB,0).toFixed(0));
