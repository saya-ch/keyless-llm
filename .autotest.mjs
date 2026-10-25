const t0=Date.now();
let ok=0,fail=0;
for(let i=1;i<=8;i++){
  const s=Date.now();
  try{
    const r=await fetch("http://127.0.0.1:8788/v1/chat/completions",{method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer sk-keyless-local"},
      body:JSON.stringify({model:"auto",max_tokens:30,stream:false,messages:[{role:"user",content:"reply with the single word: ok"}]})});
    const j=await r.json();
    const c=j.choices?.[0]?.message?.content||"";
    const good=r.status===200 && c.trim().length>0;
    if(good)ok++;else fail++;
    console.log(`${String(i).padStart(2)}. ${r.status} ${String(Date.now()-s).padStart(6)}ms ${j.model||"-"} 内容=${JSON.stringify(c.slice(0,30))} ${good?"✓":"✗"}`);
  }catch(e){fail++;console.log(`${String(i).padStart(2)}. ERR ${Date.now()-s}ms ${e.message}`);}
}
console.log(`\n成功 ${ok}/8，失败 ${fail}，总耗时 ${((Date.now()-t0)/1000).toFixed(1)}s`);
