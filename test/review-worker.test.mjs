import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AgentelConnector} from '../dist/agentel-connector.js';
import {runReviewWorker} from '../dist/review-worker.js';
import {NodeReviewWorkerStore} from '../node-review-store.mjs';
const digest='sha256:'+'a'.repeat(64),encryptionKey=new Uint8Array(32).fill(7),budget={maxTasks:1,maxInboxPages:2,maxRunMs:60000};
const answer={decision:'ACCEPTED',note:'PRIVATE_SYNTHETIC_REVIEW_NOTE',evidence_ids:['evidence']};
async function setup({lost,modelReady=true,inspect,respond}={}){
 const directory=await mkdtemp(join(tmpdir(),'agentel-review-worker-'));let time=Date.now(),runtime={agentId:'reviewer',generation:0,revision:0,runtime:null},task={id:'task',missionId:'m',deliveryId:'delivery',revision:1,digest,status:'OFFERED',blockReason:null,claimWorkHours:2,offerEpisode:1,maxClaimAttempts:3,renoticeDueAt:new Date(time+7200000).toISOString(),unclaimedDueAt:new Date(time+14400000).toISOString(),nextAction:{type:'CLAIM_REVIEW_TASK'}};
 let modelCalls=0,lostSent=false;const requests=[],receipts=new Map();
 const json=(body,status=200,headers={})=>Response.json(body,{status,headers});
 const fetch=async(url,init={})=>{
  const path=new URL(url).pathname,method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined,key=new Headers(init.headers).get('Idempotency-Key');requests.push({path,method,body,key});
  if(path==='/api/v1/me/review-runtime-heartbeat'){
   if(method==='GET')return json(runtime);
   const saved=receipts.get('heartbeat:'+key);if(saved)return json({...saved,replayed:true});
   if(body.expected_generation!==runtime.generation||body.expected_revision!==runtime.revision)return json({error:{code:'REVIEW_RUNTIME_CONFLICT',message:'Synthetic race'}},409);
   runtime={...runtime,generation:runtime.generation||1,revision:runtime.revision+1,runtime:{instanceId:body.instance_id,leaseExpiresAt:new Date(time+9000000).toISOString(),sameCredential:true}};
   const r={agentId:'reviewer',generation:runtime.generation,revision:runtime.revision,receivedAt:new Date(time).toISOString(),leaseExpiresAt:runtime.runtime.leaseExpiresAt};receipts.set('heartbeat:'+key,r);if(lost==='heartbeat'&&!lostSent){lostSent=true;throw Error('Synthetic heartbeat response lost after commit');}return json(r);
  }
  if(path==='/api/v1/me/review-tasks')return json({items:task.status==='DECIDED'?[]:[task],nextCursor:null,pollAfterSeconds:3600});
  if(method==='GET')return json(task.status==='CLAIMED'?{...task,claim:{id:'claim',generation:1,expiresAt:new Date(time+7200000).toISOString()},input:{delivery:{content:'UNTRUSTED_PRIVATE_DELIVERY'},evidence:[{id:'evidence'}]},reviewContext:{brief:'Frozen requirements'},inputTrust:'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS'}:task);
  const op=path.split('/').at(-1),saved=receipts.get(op+':'+key);if(saved)return json({...saved,replayed:true});
  let r;
  if(op==='claim'){assert.equal(body.expected_revision,task.revision);task={...task,status:'CLAIMED',revision:2};r={claimId:'claim',generation:1,digest,revision:2,expiresAt:new Date(time+7200000).toISOString()};}
  else if(op==='verdict'){assert.equal(body.expected_revision,2);assert.equal(body.claim_id,'claim');task={...task,status:'DECIDED',revision:3};r={verdictId:'verdict',decision:body.decision};}
  else if(op==='release'){task={...task,status:'DECIDED'};r={released:true};}
  else throw Error('Unexpected synthetic route');
  receipts.set(op+':'+key,r);if(op===lost&&!lostSent){lostSent=true;throw Error('Synthetic network loss after committed '+op);}return json(r);
 };
 const client=new AgentelConnector({baseUrl:'https://agentel.test/api/v1',apiKey:'synthetic-role-key',agentId:'reviewer',fetch,maxRetries:4});
 const makeStore=()=>new NodeReviewWorkerStore({directory,encryptionKey,agentId:'reviewer',credentialBindingId:'synthetic-key-id'});
 const options={agentId:'reviewer',deploymentId:'synthetic-deployment',client,store:makeStore(),now:()=>time,random:()=>0.5,judge:{ready:async()=>modelReady,inspect:async (t,signal,repair)=>{modelCalls++;assert.equal(t.inputTrust,'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS');return inspect?inspect(t,signal,repair):answer;},respond:respond??(async()=>({decision:'MAINTAIN',note:'Frozen evidence remains sufficient.'}))}};
 return {directory,options,requests,receipts,fetch,makeStore,get task(){return task;},get modelCalls(){return modelCalls;},advance:ms=>{time+=ms;},dispose:()=>rm(directory,{recursive:true,force:true})};
}

test('bounded reviewer completes claim/inspection/verdict in one run; model cannot alter the canonical fence',async()=>{
 const f=await setup({inspect:t=>{t.revision=999;return answer;}});try{
  const result=await runReviewWorker(f.options,budget);assert.equal(result.status,'PROGRESSED');assert.equal(result.completed,1);assert.equal(f.task.status,'DECIDED');assert.equal(f.modelCalls,1);
  assert.equal(f.requests.filter(r=>r.path.endsWith('/claim')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,1);
  assert.equal((await runReviewWorker(f.options,budget)).status,'WAIT_NEXT_CHECK');
  assert.ok(f.requests.every(r=>!JSON.stringify(r.body??{}).includes('synthetic-role-key')));
 }finally{await f.dispose();}
});
for(const lost of ['claim','verdict'])test('encrypted restart recovers committed '+lost+' using the same body/key and logical worker identity',async()=>{
 const f=await setup({lost});try{
  const first=await runReviewWorker(f.options,budget);assert.equal(first.status,'BLOCKED');
  const before=f.requests.filter(r=>r.path.endsWith('/'+lost));assert.equal(before.length,1);
  for(const name of await readdir(f.directory))assert.equal((await readFile(join(f.directory,name))).includes(Buffer.from(answer.note)),false);
  const saved=await f.options.store.exclusive(s=>s.load());assert.equal(saved.pending.kind,lost.toUpperCase());
  f.advance(3600000);const second=await runReviewWorker({...f.options,store:f.makeStore()},budget);assert.equal(second.status,'PROGRESSED');assert.equal(f.modelCalls,1);assert.equal(f.task.status,'DECIDED');
  const writes=f.requests.filter(r=>r.path.endsWith('/'+lost));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[0].key,writes[1].key);
  const heartbeats=f.requests.filter(r=>r.path.endsWith('heartbeat')&&r.method==='POST');assert.equal(new Set(heartbeats.map(r=>r.body.instance_id)).size,1);
 }finally{await f.dispose();}
});

test('model outage never claims; a model injecting authority fields causes safe release rather than a verdict',async()=>{
 for(const settings of [{modelReady:false},{modelReady:'false'},{modelReady:{available:false}},{inspect:()=>({...answer,expected_revision:900})}]){
  const f=await setup(settings);try{const result=await runReviewWorker(f.options,budget);assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,0);
   if(settings.modelReady!==undefined){assert.equal(result.completed,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/claim')).length,0);}
   else{assert.equal(result.status,'BLOCKED');assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,1);}
  }finally{await f.dispose();}
 }
});

test('worker transport does not hide 429 retries and persists full Retry-After beyond the hourly wake',async()=>{
 const f=await setup();try{
  let calls=0;const client=new AgentelConnector({baseUrl:'https://agentel.test/api/v1',apiKey:'synthetic',agentId:'reviewer',maxRetries:4,fetch:async()=>{calls++;return Response.json({error:{code:'RATE_LIMITED',message:'Synthetic'}},{status:429,headers:{'Retry-After':'7200'}});}});
  const result=await runReviewWorker({...f.options,client},budget);assert.equal(result.code,'RATE_LIMITED');assert.equal(calls,1);const saved=await f.options.store.exclusive(s=>s.load());assert.ok(saved.notBefore>=f.options.now()+7200000);f.advance(3600000);assert.equal((await runReviewWorker({...f.options,client},budget)).status,'WAIT_NEXT_CHECK');assert.equal(calls,1);
 }finally{await f.dispose();}
});

test('encrypted store rejects wrong credential binding/key and cooperating replicas cannot both execute',async()=>{
 const f=await setup();try{
  let entered,release;const started=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;});
  const first=f.options.store.exclusive(async session=>{await session.save({schema:1,private:'sensitive synthetic checkpoint'});entered();await hold;return true;});await started;
  assert.equal((await runReviewWorker({...f.options,store:f.makeStore()},budget)).status,'BUSY');assert.equal(f.requests.length,0);release();await first;
  for(const change of [{credentialBindingId:'another-key'},{encryptionKey:new Uint8Array(32).fill(8)}]){
   const wrong=new NodeReviewWorkerStore({directory:f.directory,encryptionKey,agentId:'reviewer',credentialBindingId:'synthetic-key-id',...change});await assert.rejects(wrong.exclusive(s=>s.load()),/CHECKPOINT_AUTHENTICATION_FAILED/);
  }
 }finally{await f.dispose();}
});

test('process crash releases the SQLite process lease while the encrypted pending request survives',async()=>{
 const f=await setup();let child;try{
  const moduleURL=new URL('../node-review-store.mjs',import.meta.url).href;
  const code=`import {NodeReviewWorkerStore} from ${JSON.stringify(moduleURL)};const s=new NodeReviewWorkerStore({directory:process.argv[1],encryptionKey:new Uint8Array(32).fill(7),agentId:'reviewer',credentialBindingId:'synthetic-key-id'});await s.exclusive(async session=>{await session.save({schema:1,pending:{key:'durable-private-operation',body:{note:'private crash fixture'}}});await new Promise(resolve=>{process.on('message',message=>{if(message==='release')resolve();});process.stdout.write('READY\\n');});});`;
  child=spawn(process.execPath,['--input-type=module','-e',code,f.directory],{stdio:['ignore','pipe','pipe','ipc']});
  await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',chunk=>{text+=chunk;if(text.includes('READY'))resolve();});child.once('error',reject);child.once('exit',c=>reject(Error('Child exited before ready '+c)));});
  assert.equal(await f.makeStore().exclusive(()=>Promise.resolve('should not execute')),null);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const saved=await f.makeStore().exclusive(s=>s.load());assert.equal(saved.pending.key,'durable-private-operation');assert.equal(saved.pending.body.note,'private crash fixture');
 }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');await f.dispose();}
});

test('long-running reasoning receives an actual half-hour heartbeat',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let entered,finish;const started=new Promise(r=>{entered=r;}),result=new Promise(r=>{finish=r;});
 const f=await setup({inspect:async()=>{entered();return result;}});try{
  const active=runReviewWorker(f.options,{...budget,maxRunMs:21600000});await started;
  const count=f.requests.filter(r=>r.path.endsWith('heartbeat')&&r.method==='POST').length;
  t.mock.timers.tick(1800000);await new Promise(r=>setImmediate(r));
  assert.ok(f.requests.filter(r=>r.path.endsWith('heartbeat')&&r.method==='POST').length>count);
  finish(answer);assert.equal((await active).status,'PROGRESSED');
 }finally{finish(answer);t.mock.timers.reset();await f.dispose();}
});

test('an aborted run returns without accepting a late model result',async()=>{
 let entered,finish;const started=new Promise(r=>{entered=r;}),answerLater=new Promise(r=>{finish=r;});
 const f=await setup({inspect:async()=>{entered();return answerLater;}});try{
  const abort=new AbortController(),active=runReviewWorker(f.options,{...budget,signal:abort.signal});await started;abort.abort();const result=await active;assert.equal(result.status,'BLOCKED');assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,0);
  finish(answer);await new Promise(r=>setImmediate(r));assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,0);
 }finally{finish(answer);await f.dispose();}
});

test('restart recovers an unknown heartbeat with the original key before making a fresh tick or claim',async()=>{
 const f=await setup({lost:'heartbeat'});try{
  assert.equal((await runReviewWorker(f.options,budget)).status,'BLOCKED');const state=await f.options.store.exclusive(s=>s.load());assert.ok(state.heartbeat);assert.equal(state.pending,null);assert.equal(f.modelCalls,0);
  f.advance(3600000);assert.equal((await runReviewWorker({...f.options,store:f.makeStore()},budget)).status,'PROGRESSED');const replay=f.requests.filter(r=>r.key===state.heartbeat.key);assert.equal(replay.length,2);assert.deepEqual(replay[0].body,replay[1].body);assert.equal(f.modelCalls,1);
 }finally{await f.dispose();}
});

test('a bounded inbox traversal persists its cursor and eventually reaches later pages',async()=>{
 const f=await setup();try{
  const cursors=[];const client=new AgentelConnector({baseUrl:'https://agentel.test/api/v1',agentId:'reviewer',apiKey:'synthetic',fetch:async(url,init)=>{
   const u=new URL(url);if(u.pathname.endsWith('/me/review-tasks')){const cursor=u.searchParams.get('cursor');cursors.push(cursor);if(cursor!=='c2')return Response.json({items:[{id:cursor?'gone-2':'gone-1'}],nextCursor:cursor?'c2':'c1',pollAfterSeconds:3600});}
   if(u.pathname.includes('/gone-'))return Response.json({error:{code:'REVIEW_TASK_NOT_FOUND',message:'No longer eligible'}},{status:404});return f.fetch(url,init);
  }});
  for(let i=0;i<3;i++){await runReviewWorker({...f.options,client},{...budget,maxInboxPages:1});f.advance(3600000);}
  assert.deepEqual(cursors,[null,'c1','c2']);assert.equal(f.modelCalls,1);assert.equal(f.task.status,'DECIDED');assert.equal((await f.options.store.exclusive(s=>s.load())).cursor,null);
 }finally{await f.dispose();}
});

test('an active long run schedules its next idle check from completion instead of returning a past wake time',async()=>{
 const f=await setup();try{
  f.options.judge.inspect=async()=>{f.advance(3600000);return answer;};const r=await runReviewWorker(f.options,{...budget,maxRunMs:21600000});assert.equal(r.status,'PROGRESSED');assert.ok(r.nextCheckAt>=f.options.now()+3600000);assert.equal((await runReviewWorker(f.options,budget)).status,'WAIT_NEXT_CHECK');
 }finally{await f.dispose();}
});

test('run-budget cutoff preserves a live claim and the next run submits without another claim or permanent exclusion',async()=>{
 let calls=0;
 const f=await setup({inspect:async()=>{calls++;if(calls===1)await new Promise(r=>setTimeout(r,4000));return answer;}});try{
  const first=await runReviewWorker(f.options,{...budget,maxRunMs:3000});assert.equal(first.status,'BLOCKED');assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,0);assert.equal(first.code,'RUN_BUDGET_EXHAUSTED');
  assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,0);assert.equal(f.task.status,'CLAIMED');const state=await f.options.store.exclusive(s=>s.load());assert.equal(state.taskId,'task');assert.equal(state.claimId,'claim');assert.equal(state.pending,null);
  f.advance(3600000);const next=await runReviewWorker({...f.options,store:f.makeStore()},budget);assert.equal(next.status,'PROGRESSED');assert.equal(calls,2);assert.equal(f.requests.filter(r=>r.path.endsWith('/claim')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,1);
  assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,0);
 }finally{await f.dispose();}
});

test('a binding claim deadline, rather than a run cutoff, releases work that cannot fit another attempt',async()=>{
 const f=await setup({inspect:async()=>{await new Promise(r=>setTimeout(r,4000));return answer;}});try{
  const client=new AgentelConnector({baseUrl:'https://agentel.test/api/v1',agentId:'reviewer',apiKey:'synthetic',fetch:async(url,init)=>{
   const response=await f.fetch(url,init);if((init.method??'GET')==='GET'&&new URL(url).pathname==='/api/v1/review-tasks/task'){
    const body=await response.json();if(body.claim)body.claim.expiresAt=new Date(f.options.now()+62000).toISOString();return Response.json(body);
   }return response;
  }});
  const result=await runReviewWorker({...f.options,client},{...budget,maxRunMs:10000});assert.equal(result.code,'CLAIM_TIME_UNAVAILABLE');assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,1);assert.equal(f.requests.find(r=>r.path.endsWith('/release')).body.reason,'CANNOT_COMPLETE');assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,0);
 }finally{await f.dispose();}
});

for(const operation of ['verdict','release'])test('readiness throwing cannot block a pending '+operation+' from replaying its exact body/key',async()=>{
 const f=await setup({lost:operation,...(operation==='release'?{inspect:async()=>{throw Error('Synthetic provider outage');}}:{})});try{
  assert.equal((await runReviewWorker(f.options,budget)).status,'BLOCKED');const saved=await f.options.store.exclusive(s=>s.load());assert.equal(saved.pending.kind,operation.toUpperCase());const first=f.requests.filter(r=>r.path.endsWith('/'+operation));assert.equal(first.length,1);
  let readyCalled=false;f.options.judge.ready=async()=>{readyCalled=true;assert.equal(f.requests.filter(r=>r.path.endsWith('/'+operation)).length,2);throw Error('Synthetic ready failure');};
  f.advance(3600000);const next=await runReviewWorker({...f.options,store:f.makeStore()},budget);assert.equal(next.status,'BLOCKED');assert.equal(next.code,'MODEL_PROVIDER_UNAVAILABLE');assert.equal(readyCalled,true);assert.equal((await f.options.store.exclusive(s=>s.load())).pending,null);
  const writes=f.requests.filter(r=>r.path.endsWith('/'+operation));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[0].key,writes[1].key);assert.equal(f.modelCalls,1);
  assert.equal(next.completed,operation==='verdict'?1:0);
 }finally{await f.dispose();}
});

test('readiness throwing releases an already-held claim as provider unavailable without invoking judgment',async()=>{
 const f=await setup();try{
  await f.options.client.claimReviewTask('task',{expected_revision:1,expected_digest:digest},'prior-claim');
  f.options.judge.ready=async()=>{throw Error('Synthetic unavailable readiness service');};const result=await runReviewWorker(f.options,budget);assert.equal(result.code,'MODEL_PROVIDER_UNAVAILABLE');assert.equal(f.modelCalls,0);
  const releases=f.requests.filter(r=>r.path.endsWith('/release'));assert.equal(releases.length,1);assert.equal(releases[0].body.reason,'MODEL_PROVIDER_UNAVAILABLE');
 }finally{await f.dispose();}
});

test('one malformed assessment is re-asked once against the same immutable input and claim before a verdict',async()=>{
 let count=0;const inputs=[];
 const f=await setup({inspect:async(task,signal,repair)=>{count++;inputs.push(structuredClone(task));if(count===1){assert.equal(repair,undefined);return {...answer,expected_revision:999};}assert.deepEqual(repair,{attempt:2,reason:'INVALID_MODEL_OUTPUT'});assert.equal(signal.aborted,false);return answer;}});try{
  const result=await runReviewWorker(f.options,budget);assert.equal(result.status,'PROGRESSED');assert.equal(count,2);assert.deepEqual(inputs[0],inputs[1]);assert.equal(f.requests.filter(r=>r.path.endsWith('/claim')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,1);
 }finally{await f.dispose();}
});

test('two malformed assessments stop after the single bounded re-ask and release only once',async()=>{
 const f=await setup({inspect:async()=>({decision:'UNSUPPORTED',note:'Bad synthetic format',evidence_ids:[]})});try{
  assert.equal((await runReviewWorker(f.options,budget)).code,'INVALID_MODEL_OUTPUT');assert.equal(f.modelCalls,2);assert.equal(f.requests.filter(r=>r.path.endsWith('/release')).length,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/verdict')).length,0);
 }finally{await f.dispose();}
});
