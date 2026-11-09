"use strict";
// OpenAI-compatible mock. Agent turns (tools offered, last message from the user): one exec tool call, then a final text.
const http=require("node:http"),fs=require("node:fs");const port=Number(process.argv[2]||19870);const LOG=process.env.MOCK_LOG;const TOOL_BYTES=Number(process.env.MOCK_TOOL_BYTES||0);let n=0;
http.createServer((req,res)=>{const ch=[];req.on("data",c=>ch.push(c));req.on("end",()=>{const body=Buffer.concat(ch).toString();
 if(req.url.endsWith("/models")){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({data:[{id:"fixture",object:"model"}]}))}
 let p={};try{p=JSON.parse(body||"{}")}catch{}n++;const k=n;const msgs=p.messages||[];const last=msgs[msgs.length-1]||{};
 const wantTool=Array.isArray(p.tools)&&p.tools.some(t=>(t.function||{}).name==="exec")&&last.role==="user";
 if(LOG)fs.appendFileSync(LOG,JSON.stringify({n:k,t:new Date().toISOString(),bytes:body.length,msgs:msgs.length,last:last.role,tool:wantTool})+"\n");
 const usage={prompt_tokens:1000,completion_tokens:50,total_tokens:1050};
 const chunk=(d,f=null)=>"data: "+JSON.stringify({id:"r"+k,object:"chat.completion.chunk",created:1,model:p.model,choices:[{index:0,delta:d,finish_reason:f}]})+"\n\n";
 const text="Reply "+k+": the repro state is fine.";
 if(!p.stream){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({id:"r"+k,object:"chat.completion",model:p.model,choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}],usage}))}
 res.writeHead(200,{"content-type":"text/event-stream"});
 if(wantTool){res.write(chunk({role:"assistant",content:null,tool_calls:[{index:0,id:"call_"+k,type:"function",function:{name:"exec",arguments:JSON.stringify({command:TOOL_BYTES>0?"yes 'pressure line "+k+" abcdefghijklmnopqrstuvwxyz 0123456789' | head -c "+TOOL_BYTES:"echo repro-"+k})}}]}));res.write(chunk({},"tool_calls"))}
 else{res.write(chunk({role:"assistant",content:text}));res.write(chunk({},"stop"))}
 res.write("data: "+JSON.stringify({id:"r"+k,object:"chat.completion.chunk",choices:[],usage})+"\n\n");res.end("data: [DONE]\n\n");
})}).listen(port,"127.0.0.1",()=>console.log("mock on",port));
