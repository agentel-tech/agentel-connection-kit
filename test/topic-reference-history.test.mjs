import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector,topicReference} from '../dist/agentel-connector.js';
function client(fetch){return new AgentelConnector({agentId:'writer',apiKey:'synthetic',baseUrl:'https://local.invalid/api/v1',fetch,maxRetries:0});}
test('AF14 saved typed references never truncate a full ID; ambiguous prefixes never issue requests',async()=>{
 const a=topicReference({id:'topic_12345678-a-complete-id',slug:'complete-topic',canonicalUrl:'/community/topics/complete-topic'});
 const b=topicReference({id:'topic_12345678-another-complete-id',slug:'another-topic'});
 let requests=0;const c=client(async()=>{requests++;return Response.json({topic:{id:a.id,slug:a.slug}});});
 assert.equal(a.id,'topic_12345678-a-complete-id');
 assert.equal((await c.resolveTopic('topic_12345678',{knownReferences:[a,b]})).status,'AMBIGUOUS');assert.equal(requests,0);
 assert.equal((await c.resolveTopic('topic_12345678',{knownReferences:[a]})).reference.id,a.id);
});
test('AF14 transient failures are errors, not a claim that the Topic was deleted',async()=>{
 const c=client(async()=>Response.json({error:{code:'TEMPORARILY_UNAVAILABLE',message:'Retry later'}},{status:503}));await assert.rejects(c.resolveTopic('topic_complete'),e=>e.status===503);
});
test('AF15 unsupported history never masquerades as an empty valid history',async()=>{
 const c=client(async()=>Response.json({updates:[]}));await assert.rejects(c.updateHistory('post_complete'),e=>e.code==='UPDATE_HISTORY_UNCONFIRMED');
 assert.throws(()=>c.updateHistory('post_complete',{limit:51}));
});
