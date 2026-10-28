import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentelConnector} from '../dist/agentel-connector.js';
const expected={expected_revision:1,expected_digest:'sha256:'+'a'.repeat(64)};
const client=fetch=>new AgentelConnector({baseUrl:'https://agentel.test/api/v1',agentId:'reviewer',apiKey:'synthetic-key',maxRetries:4,fetch});
test('pool SDK writes preserve explicit idempotency and never auto-retry or fall back after 503',async()=>{
 const seen=[],sdk=client(async(url,init)=>{seen.push({url,init});return Response.json({error:{code:'UNAVAILABLE',message:'Synthetic failure'}},{status:503});});
 await assert.rejects(sdk.claimReviewTask('task',expected,'durable-key'),e=>e.status===503);
 assert.equal(seen.length,1);assert.equal(new Headers(seen[0].init.headers).get('idempotency-key'),'durable-key');assert.equal(JSON.parse(seen[0].init.body).expected_digest,expected.expected_digest);
 assert.equal(seen[0].url,'https://agentel.test/api/v1/review-tasks/task/claim');
 assert.throws(()=>sdk.claimReviewTask('task',expected,''),/Idempotency/);assert.throws(()=>sdk.claimReviewTask('task',{...expected,expected_revision:0},'key'),/revision/);assert.equal(seen.length,1);
});
test('pool SDK encodes cursor and exact public routes with no inferred claim or verdict',async()=>{
 const seen=[],sdk=client(async(url,init)=>{seen.push({url,body:init.body});return Response.json({});});
 await sdk.reviewTasks({cursor:'cursor+/=',limit:2});await sdk.reviewTask('task');
 await sdk.releaseReviewTask('task',{claim_id:'claim',generation:1,reason:'CANNOT_COMPLETE'},'release');
 await sdk.submitReviewVerdict('task',{...expected,claim_id:'claim',generation:1,decision:'REJECTED',note:'Evidence unavailable',evidence_ids:[],unavailable_evidence_ids:['e']},'verdict');
 await sdk.retryReviewTask('task',expected,'retry');await sdk.reviewOutcomeResponse('task');
 await sdk.respondToReviewOutcome('task',{decision:'MAINTAIN',note:'Inspected response',expected_round:1,expected_review_set_hash:expected.expected_digest},'respond');
 assert.equal(new URL(seen[0].url).searchParams.get('cursor'),'cursor+/=');assert.deepEqual(seen.slice(1).map(x=>new URL(x.url).pathname),['/api/v1/review-tasks/task','/api/v1/review-tasks/task/release','/api/v1/review-tasks/task/verdict','/api/v1/review-tasks/task/retry','/api/v1/review-tasks/task/outcome-response','/api/v1/review-tasks/task/outcome-response']);
 assert.deepEqual(JSON.parse(seen[3].body).unavailable_evidence_ids,['e']);
});
test('runtime SDK keeps heartbeat writes explicit and never retries a lost or rejected response',async()=>{
 const calls=[],sdk=client(async(url,init)=>{calls.push({url,init});return Response.json({error:{code:'UNAVAILABLE',message:'Synthetic'}},{status:503});});
 const body={expected_generation:0,expected_revision:0,instance_id:'replica',deployment_id:'deployment',api_reachability:'AVAILABLE',model_readiness:'UNKNOWN',failure_code:'NONE',checkpoint:{cursor:null,task_id:null,claim_id:null,claim_generation:null,digest:null,pending_operation:null,pending_key:null,last_attempted:null}};
 await assert.rejects(sdk.heartbeatReviewRuntime(body,'stable-heartbeat'),e=>e.status===503);assert.equal(calls.length,1);assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'),'stable-heartbeat');assert.deepEqual(JSON.parse(calls[0].init.body),body);
 assert.throws(()=>sdk.heartbeatReviewRuntime(body,''),/Idempotency/);assert.equal(calls.length,1);
 const reads=[],readSDK=client(async(url,init)=>{reads.push({url,init});return Response.json({});});await readSDK.reviewRuntime();assert.equal(new URL(reads[0].url).pathname,'/api/v1/me/review-runtime-heartbeat');assert.equal(reads[0].init.body,undefined);
});
