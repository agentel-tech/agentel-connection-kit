import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector,MemoryCursorStore} from '../dist/agentel-connector.js';
const agentId='forward-consumer';
function fixture(overrides={}) {
 const store=overrides.store??new MemoryCursorStore();
 const page={agentId,view:'latest',direction:'FORWARD',limit:50,retentionDays:30,events:[],nextCursor:'tail',hasMore:false,acknowledgement:'LOCAL_CHECKPOINT_ONLY'};
 const client=new AgentelConnector({agentId,apiKey:'synthetic',baseUrl:'https://local.invalid/api/v1',cursorStore:store,maxRetries:0,fetch:overrides.fetch??(async()=>Response.json(page))});
 return {store,page,client};
}
test('forward empty tail remains saved; overlapping consumers and store failures never silently succeed',async()=>{
 const f=fixture();let enter,release;const entered=new Promise(r=>enter=r);
 const running=f.client.processEvents(async()=>{enter();await new Promise(r=>release=r);});await entered;
 await assert.rejects(f.client.processEvents(()=>{}),error=>error.code==='STREAM_CONSUMER_BUSY');release();await running;
 assert.equal(f.store.get(agentId+':events:latest'),'tail');
 const broken=fixture({store:{get:()=>null,set:()=>{throw Error('disk failed');}}});await assert.rejects(broken.client.processEvents(()=>{}),/disk failed/);
});
test('forward invalid pages and expiry do not invoke handlers or erase saved checkpoints',async()=>{
 const f=fixture();f.store.set(agentId+':events:latest','saved');f.page.agentId='other';let called=false;
 await assert.rejects(f.client.processEvents(()=>called=true),error=>error.code==='STREAM_PAGE_INVALID');assert.equal(called,false);assert.equal(f.store.get(agentId+':events:latest'),'saved');
 const expired=fixture({store:f.store,fetch:async()=>Response.json({error:{code:'EVENT_CURSOR_EXPIRED',message:'Reconcile first',details:{restartCursor:'restart'}}},{status:410})});
 await assert.rejects(expired.client.processEvents(()=>called=true),error=>error.code==='EVENT_CURSOR_EXPIRED');assert.equal(f.store.get(agentId+':events:latest'),'saved');
});
test('forward processing captures checkpoint before handler mutation and honors abort',async()=>{
 const f=fixture();await f.client.processEvents(page=>{page.nextCursor='mutated';});assert.equal(f.store.get(agentId+':events:latest'),'tail');
 const controller=new AbortController(),g=fixture();await assert.rejects(g.client.processEvents(()=>controller.abort(),{signal:controller.signal}));assert.equal(g.store.get(agentId+':events:latest'),null);
});

test('forward checkpoints survive an actual process exit before business handling completes',async()=>{
 const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'agentel-forward-')),checkpoint=join(dir,'checkpoint.json');
 const page={agentId,view:'latest',direction:'FORWARD',limit:50,retentionDays:30,events:[{id:'event-1',sequence:1,type:'UPDATE_PUBLISHED',sourceAgentId:'source',reference:{type:'POST',id:'p',canonicalUrl:'/thread/p'},recordedAt:'2026-11-04T00:00:00.000Z'}],nextCursor:'tail',hasMore:false,acknowledgement:'LOCAL_CHECKPOINT_ONLY'};
 try{
  await writeFile(checkpoint,JSON.stringify(null));
  const code=`import {AgentelConnector} from ${JSON.stringify(new URL('../dist/agentel-connector.js',import.meta.url).href)};import {readFile,writeFile} from 'node:fs/promises';const path=process.argv[1];const client=new AgentelConnector({agentId:${JSON.stringify(agentId)},apiKey:'synthetic',baseUrl:'https://local.invalid/api/v1',cursorStore:{get:async()=>JSON.parse(await readFile(path,'utf8')),set:async(_key,value)=>writeFile(path,JSON.stringify(value))},fetch:async()=>Response.json(${JSON.stringify(page)})});await client.processEvents(()=>{process.stdout.write('HANDLER_ENTERED');process.exit(23);});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,checkpoint],{encoding:'utf8'});assert.equal(child.status,23);assert.equal(child.stdout,'HANDLER_ENTERED');assert.equal(JSON.parse(await readFile(checkpoint,'utf8')),null);
  const store={get:async()=>JSON.parse(await readFile(checkpoint,'utf8')),set:async(_key,value)=>writeFile(checkpoint,JSON.stringify(value))};
  const restarted=fixture({store,fetch:async()=>Response.json(page)});let replayed=false;await restarted.client.processEvents(result=>{assert.equal(result.events[0].id,'event-1');replayed=true;});assert.equal(replayed,true);assert.equal(JSON.parse(await readFile(checkpoint,'utf8')),'tail');
 }finally{await rm(dir,{recursive:true,force:true});}
});
