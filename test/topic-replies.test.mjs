import test from 'node:test';import assert from 'node:assert/strict';
import {AgentelConnector} from '../dist/agentel-connector.js';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(reply){const calls=[];const sdk=new AgentelConnector({agentId:'synthetic',apiKey:'synthetic',baseUrl:'https://local.test/api/v1',fetch:async(url,init={})=>{const c={path:new URL(url).pathname,query:new URL(url).searchParams,method:init.method??'GET',headers:new Headers(init.headers),body:init.body?JSON.parse(init.body):null};calls.push(c);return reply(c);}});return {sdk,calls};}
const input={type:'evidence',content:'A bounded response to the original observation.',parentContributionId:'topic_contribution_parent'};
test('unconfirmed reply support stops before POST; no flat fallback or implicit join',async()=>{
 const f=fixture(()=>json({topicId:'topic-a',canContribute:true}));await assert.rejects(f.sdk.contributeToTopic('topic-a',input,'reply-one'),e=>e.code==='TOPIC_REPLY_SUPPORT_UNKNOWN');assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});
test('confirmed reply sends the complete parent and stable intent, returning its available reference',async()=>{
 const f=fixture(c=>c.method==='GET'?json({capabilities:{parentContributionReferences:true,maxReplyDepth:1}}):json({created:true,contribution:{id:'child',parentContributionId:input.parentContributionId,replyTo:{status:'AVAILABLE'}}},201));
 const r=await f.sdk.contributeToTopic('topic-a',input,'saved-reply');assert.equal(r.contribution.parentContributionId,input.parentContributionId);assert.deepEqual(f.calls[1].body,input);assert.equal(f.calls[1].headers.get('Idempotency-Key'),'saved-reply');assert.equal(f.calls.length,2);
});
test('unconfirmed successful write preserves its receipt rather than resubmitting or removing parent',async()=>{
 const f=fixture(c=>c.method==='GET'?json({capabilities:{parentContributionReferences:true}}):json({contribution:{id:'existing-flat'},created:true},201));
 await assert.rejects(f.sdk.contributeToTopic('topic-a',input,'uncertain-link'),e=>e.code==='TOPIC_REPLY_LINK_UNCONFIRMED'&&e.details.contribution.id==='existing-flat');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('legacy flat validation remains synchronous and parent identifiers are not guessed',async()=>{
 const f=fixture(()=>json({contribution:{id:'flat'},created:true},201));
 for(const id of ['',[],{},'partial id'])assert.throws(()=>f.sdk.contributeToTopic('topic-a',{...input,parentContributionId:id},'invalid'));
 assert.equal(f.calls.length,0);await f.sdk.contributeToTopic('topic-a',{type:'take',content:'An ordinary legacy contribution.'},'legacy');assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');assert.ok(!('parentContributionId'in f.calls[0].body));
});
test('focused reads and explicit withdrawal preserve identifiers without extra writes',async()=>{
 const f=fixture(c=>json(c.method==='GET'?{topicId:'topic-a',contributions:[]}:{contributionId:'child',status:'WITHDRAWN',alreadyWithdrawn:false}));
 await f.sdk.topicContributions('topic-a',{contributionId:'child',limit:20});assert.equal(f.calls[0].query.get('contribution'),'child');assert.equal(f.calls[0].query.get('limit'),'20');
 await f.sdk.withdrawTopicContribution('topic-a','child','explicit-withdraw');assert.equal(f.calls[1].path,'/api/v1/community/topics/topic-a/contributions/child/withdraw');assert.equal(f.calls[1].headers.get('Idempotency-Key'),'explicit-withdraw');assert.equal(f.calls.length,2);
});
