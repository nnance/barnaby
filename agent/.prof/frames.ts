// What arrives before the first content token, and when?
const M="qwen3.6-35b-a3b-8bit";
const sys={role:"system",content:"You are Barnaby, a companion robot in a shared home.\n\nIf you do not know something, say so plainly rather than guessing.\n\nNever read out personal information unless you have been told who is asking.\n\nAbout the household you live with:\n\nYou live on the kitchen counter in Nick and Rhonda's home in Norman, Oklahoma, at latitude 35.22257 and longitude -97.43948. Nick and Rhonda are married. When either of them asks about the weather, or about anything local, they mean Norman.\n\nYour answers are spoken aloud. Answer in one or two short sentences."};
const TOOLS=[{type:"function",function:{name:"get_forecast",
  description:"Get the daily weather forecast for a location: conditions, high and low temperature, and chance of precipitation. Returns structured data for the requested days starting today. Use it for any question about weather, temperature, rain, snow, or what to wear.",
  parameters:{type:"object",properties:{latitude:{type:"number",description:"Latitude of the location, between -90 and 90."},longitude:{type:"number",description:"Longitude of the location, between -180 and 180."},days:{type:"integer",description:"Number of days to return, starting with today. 1 is today only, 2 includes tomorrow, and so on.",minimum:1,maximum:16}},required:["latitude","longitude","days"]}}}];
async function trace(label, withTools){
  const t0=Date.now();
  const r=await fetch("http://nicks-mac-studio.local:8001/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({model:M,messages:[sys,{role:"user",content:"What is a good name for a cat?"}],stream:true,max_tokens:400,...(withTools?{tools:TOOLS}:{})})});
  console.log(`\n${label}: headers at +${Date.now()-t0}ms`);
  const rd=r.body.getReader(),dec=new TextDecoder();let buf="",n=0,firstContent=null;
  for(;;){const{done,value}=await rd.read();if(done)break;
    buf+=dec.decode(value,{stream:true});let i;
    while((i=buf.indexOf("\n"))!==-1){const L=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(L==="")continue; n++;
      const at=Date.now()-t0;
      if(n<=4) console.log(`   frame ${n} at +${at}ms: ${L.slice(0,90)}`);
      if(L.startsWith("data: ")&&!L.includes("[DONE]")){
        try{const c=JSON.parse(L.slice(6)).choices[0]?.delta?.content; if(c&&firstContent===null){firstContent=at;console.log(`   FIRST CONTENT at +${at}ms (frame ${n})`);}}catch{}}}}
}
await trace("warm", false);
await trace("no tools", false);
await trace("WITH tools", true);
