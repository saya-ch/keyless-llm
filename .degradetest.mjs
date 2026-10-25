// 模拟上游全挂：起一个 mock 上游，对所有路径返回 500
import http from "node:http";
const mock=http.createServer((req,res)=>{
  if(req.url==="/models"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({data:[{id:"mock/model-free",tier:"anonymous"}]}));}
  res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"upstream dead"}}));
});
await new Promise(r=>mock.listen(9911,r));
console.log("mock 上游已启动（全部 500）\n");

// 用 auto 请求 mock 网关：auto 应该尝试多个模型但最终失败，且快速返回
const t0=Date.now();
try{
  const r=await fetch("http://127.0.0.1:8788/v1/chat/completions",{method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer sk-keyless-local"},
    body:JSON.stringify({model:"auto",max_tokens:30,stream:false,messages:[{role:"user",content:"hi"}]})});
  console.log(`网关返回 ${r.status}，耗时 ${Date.now()-t0}ms`);
  console.log("body:",(await r.text()).slice(0,200));
}catch(e){console.log("网关异常:",e.message);}
mock.close();
