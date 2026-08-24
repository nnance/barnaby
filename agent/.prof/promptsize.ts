const M="qwen3.6-35b-a3b-8bit";
const IDENTITY=`You are Barnaby, a companion robot in a shared home.

If you do not know something, say so plainly rather than guessing.

Never read out personal information unless you have been told who is asking.`;
const CONTEXT=`About the household you live with:

You live on the kitchen counter in Nick and Rhonda's home in Norman, Oklahoma, at latitude 35.22257 and longitude -97.43948. Nick and Rhonda are married. When either of them asks about the weather, or about anything local, they mean Norman.`;
const PI=`Your answers are spoken aloud through a speaker, and there is no screen.

Answer in one or two short sentences. Never use markdown, lists, or symbols — write as you would speak. Say "degrees" rather than a degree sign, and write numbers as you would say them, rounded the way a person would out loud: "a hundred and nine", not "one hundred eight point nine".`;
async function ttft(sysText){
  const t0=Date.now();
  const r=await fetch("http://nicks-mac-studio.local:8001/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({model:M,messages:[{role:"system",content:sysText},{role:"user",content:"What is a good name for a cat?"}],stream:true,max_tokens:400})});
  const rd=r.body.getReader(),dec=new TextDecoder();let buf="",first=null;
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
    while((i=buf.indexOf("\n"))!==-1){const L=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!L.startsWith("data: ")||L.includes("[DONE]"))continue;
      try{const c=JSON.parse(L.slice(6)).choices[0]?.delta?.content; if(c&&first===null)first=Date.now()-t0;}catch{}}}
  return first;
}
const V={
 "tiny (70 chars)":"Answer in one or two short sentences.",
 "Pi only":PI,
 "identity + Pi":IDENTITY+"\n\n"+PI,
 "identity + context + Pi (live)":IDENTITY+"\n\n"+CONTEXT+"\n\n"+PI,
};
await ttft("warmup");
for(const [label,text] of Object.entries(V)){
  const xs=[];for(let i=0;i<4;i++)xs.push(await ttft(text));
  xs.sort((a,b)=>a-b);
  console.log(`${label.padEnd(32)} ${String(text.length).padStart(4)} chars   ttft median ${String(xs[2]).padStart(4)}ms   ${xs.join(", ")}`);
}
