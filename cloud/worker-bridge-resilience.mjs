const nativeFetch=globalThis.fetch.bind(globalThis);
let lastDedupPayload=null;

function requestAction(init){
  try{
    const body=typeof init?.body==='string'?JSON.parse(init.body):null;
    return String(body?.action||'');
  }catch{return '';}
}

function jsonResponse(payload){
  return new Response(JSON.stringify(payload),{
    status:200,
    headers:{'content-type':'application/json; charset=utf-8'}
  });
}

globalThis.fetch=async function resilientFetch(input,init={}){
  if(requestAction(init)!=='getCloudDedupIndex')return nativeFetch(input,init);

  try{
    const response=await nativeFetch(input,init);
    if(response.ok){
      try{
        const data=await response.clone().json();
        if(data?.ok===true&&Array.isArray(data.mapsKeys)&&Array.isArray(data.mapsUrls))lastDedupPayload=data;
      }catch{}
      return response;
    }

    if(response.status===404||response.status>=500){
      const fallback=lastDedupPayload||{ok:true,mapsKeys:[],mapsUrls:[],bridgeFallback:true};
      console.warn(JSON.stringify({ts:new Date().toISOString(),event:'dedup-index-bridge-fallback',status:response.status,cached:Boolean(lastDedupPayload)}));
      return jsonResponse(fallback);
    }
    return response;
  }catch(err){
    const fallback=lastDedupPayload||{ok:true,mapsKeys:[],mapsUrls:[],bridgeFallback:true};
    console.warn(JSON.stringify({ts:new Date().toISOString(),event:'dedup-index-bridge-fallback',error:err?.message||String(err),cached:Boolean(lastDedupPayload)}));
    return jsonResponse(fallback);
  }
};

await import('./worker.mjs');
