import fs from 'node:fs/promises';

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

// The base V3 worker accepted the raw substring "tatu". That also matches
// "toelettatura", so pet groomers could enter MASTER. Patch the worker that the
// cloud workflow reconstructs before importing it. Keep strong tattoo terms and
// allow "ink..." only from the business name at a word boundary, never from a
// generic website such as linktr.ee.
const workerUrl=new URL('./worker.mjs',import.meta.url);
const workerSource=await fs.readFile(workerUrl,'utf8');
const oldFilter="function isTattoo(item){const hay=`${item?.name||''} ${item?.address||''} ${item?.website||''}`.toLowerCase();return /tattoo|tatu|tatou|ink/.test(hay);}";
const newFilter="function isTattoo(item){const name=String(item?.name||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');const hay=`${name} ${item?.address||''} ${item?.website||''}`.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');const strong=/tattoo|tatou|tatuagg|tatuator|tatuatric/.test(hay);const inkName=/\\bink[a-z0-9]*/.test(name);return strong||inkName;}";
if(!workerSource.includes(oldFilter))throw new Error('Tattoo filter patch target not found in worker.mjs');

const filterCheck=(item)=>{
  const name=String(item?.name||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const hay=`${name} ${item?.address||''} ${item?.website||''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const strong=/tattoo|tatou|tatuagg|tatuator|tatuatric/.test(hay);
  const inkName=/\bink[a-z0-9]*/.test(name);
  return strong||inkName;
};
const checks=[
  [filterCheck({name:'Bubushine - Toelettatura per cani'}),false,'toelettatura'],
  [filterCheck({name:'Ohana Toelettatura',website:'https://example.com'}),false,'grooming'],
  [filterCheck({name:'Mario Rossi',website:'https://linktr.ee/mario'}),false,'linktree'],
  [filterCheck({name:'Black Rose Tattoo'}),true,'tattoo'],
  [filterCheck({name:'Marco Tatuatore'}),true,'tatuatore'],
  [filterCheck({name:'Studio Tatuaggi Roma'}),true,'tatuaggi'],
  [filterCheck({name:'InkLab'}),true,'ink-brand'],
];
for(const [actual,expected,label] of checks){if(actual!==expected)throw new Error(`Tattoo filter self-test failed: ${label}`);}
await fs.writeFile(workerUrl,workerSource.replace(oldFilter,newFilter));

await import('./worker.mjs');
