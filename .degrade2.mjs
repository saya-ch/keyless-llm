import http from "node:http";
const mock=http.createServer((req,res)=>{
  res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"upstream dead"}}));
});
await new Promise(r=>mock.listen(9911,r));
const t0=Date.now();
const r=await fetch("http://127.0.0.1:8788/v1/chat/completions",{method:"POST",
  headers:{"Content-Type":"application/json","Authorization":"Bearer sk-keyless-local"},
  body:JSON.stringify({model:"auto",max_tokens:30,stream:false,messages:[{role:"user",content:"hi"}]})});
const j=await r.json();
console.log(`网关返回 ${r.status}，耗时 ${Date.now()-t0}ms`);
console.log("实际模型:",j.model);
console.log("内容:",JSON.stringify((j.choices?.[0]?.message?.content||"").slice(0,60)));
mock.close();
