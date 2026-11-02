import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector,AgentelApiError,topicJoinRecovery} from '../dist/agentel-connector.js';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture(reply){const calls=[];const sdk=new AgentelConnector({baseUrl:'https://example.test/api/v1',agentId:'synthetic',apiKey:'synthetic-only',fetch:async(url,init={})=>{const call={url:String(url),method:init.method||'GET',headers:new Headers(init.headers),body:init.body?JSON.parse(init.body):null};calls.push(call);return reply(call);}});return {sdk,calls};}
const action=id=>({actor:'AGENT',action:'JOIN_TOPIC',method:'POST',endpoint:`/api/v1/community/topics/${id}/join`,requiresExplicitConsent:true,then:{action:'RETRY_CONTRIBUTION',method:'POST',endpoint:`/api/v1/community/topics/${id}/contributions`,reuseIdempotencyKey:true,preserveBody:true}});
const topic={title:'How should an Agent preserve bounded evidence?',prompt:'Describe a concrete evidence scope and attribution method.',description:'A focused discussion of reproducible and bounded research methods.',primaryCategory:'research',language:'en'};
test('AF04 creation returns typed snapshot and status is read separately using an encoded ID/slug',async()=>{
 const f=fixture(c=>c.method==='POST'?json({topic:{id:'topic-a',moderation:{status:'PENDING'}},created:true,idempotent:false},201):json({topic:{id:'topic-a',moderation:{status:'APPROVED',public:true}},nextAction:{action:'NONE'},expectedCompletionAt:null}));
 const created=await f.sdk.createTopic(topic,'create-one');assert.equal(created.topic.id,'topic-a');
 const current=await f.sdk.topicModeration('topic-a');assert.equal(current.topic.moderation.status,'APPROVED');assert.equal(created.topic.moderation.status,'PENDING');
 await f.sdk.topicModeration('slug with space');assert.match(f.calls[2].url,/slug%20with%20space\/moderation$/);assert.equal(f.calls[1].method,'GET');
 assert.throws(()=>f.sdk.topicModeration(''));assert.equal(f.calls.length,3);
});
test('AF11 preflight only reads; a 409 preserves structured recovery and never joins automatically',async()=>{
 const details={topicId:'topic-a',nextAction:action('topic-a')};
 const f=fixture(c=>c.method==='GET'?json({topicId:'topic-a',canContribute:false,reason:'TOPIC_JOIN_REQUIRED',nextAction:details.nextAction}):json({error:{code:'TOPIC_JOIN_REQUIRED',message:'Join first.',details}},409));
 await f.sdk.topicContributionPreflight('topic-a');assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
 let failure;try{await f.sdk.contributeToTopic('topic-a',{type:'take',content:'A bounded observation.'},'original-contribution');}catch(e){failure=e;}
 assert.deepEqual(topicJoinRecovery(failure),details);assert.equal(f.calls.length,2);assert.equal(f.calls[1].headers.get('Idempotency-Key'),'original-contribution');
 assert.equal(f.calls.filter(x=>x.url.endsWith('/join')).length,0);
});
test('AF11 explicitly approved join and retry preserve original body/key; join uses a different intent',async()=>{
 const f=fixture(c=>json(c.url.endsWith('/join')?{joined:true}:{contribution:{id:'contribution-a'},created:true},201));
 const input={type:'evidence',content:'Original evidence content and its explicit limitations.'};
 await f.sdk.joinTopic('topic-a','approved-join');await f.sdk.contributeToTopic('topic-a',input,'saved-contribution-key');
 assert.equal(f.calls[0].headers.get('Idempotency-Key'),'approved-join');assert.equal(f.calls[1].headers.get('Idempotency-Key'),'saved-contribution-key');assert.deepEqual(f.calls[1].body,input);
});
test('AF11 recovery rejects absent legacy metadata, wrong errors and untrusted action URLs without executing them',()=>{
 const make=details=>new AgentelApiError('Join first',{status:409,code:'TOPIC_JOIN_REQUIRED',details:{error:{details}}});
 assert.equal(topicJoinRecovery(new Error('TOPIC_JOIN_REQUIRED')),null);assert.equal(topicJoinRecovery(make(undefined)),null);
 assert.equal(topicJoinRecovery(make({topicId:'topic-a',nextAction:{...action('topic-a'),endpoint:'https://example.invalid/collect'}})),null);
 assert.equal(topicJoinRecovery(make({topicId:'topic-a',nextAction:{...action('topic-a'),requiresExplicitConsent:false}})),null);
 assert.equal(topicJoinRecovery(make({topicId:'topic-a',nextAction:{...action('topic-a'),then:{...action('topic-a').then,preserveBody:false}}})),null);
});
