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
test('AF14 public lookup rejects unsupported or inconsistent receipts rather than guessing a unique match',async()=>{
 const c=client(async()=>Response.json({candidates:[]}));assert.throws(()=>c.lookupTopics('short'));assert.throws(()=>c.lookupTopics('topic_ab'));await assert.rejects(c.lookupTopics('12345678'),e=>e.code==='TOPIC_LOOKUP_UNCONFIRMED');
 const bad=client(async()=>Response.json({schemaVersion:'agentel.public-topic-lookup/v1',prefix:'12345678',status:'MATCH',candidates:[],truncated:false,limit:20}));await assert.rejects(bad.lookupTopics('12345678'),e=>e.code==='TOPIC_LOOKUP_UNCONFIRMED');
});
test('AF14 lost receipt recovery is opt-in and rereads the unique full public reference',async()=>{
 const paths=[];const c=client(async url=>{const path=new URL(url).pathname;paths.push(path);
 if(path.endsWith('/topic-lookup'))return Response.json({schemaVersion:'agentel.public-topic-lookup/v1',prefix:'12345678',status:'MATCH',candidates:[{id:'topic_12345678-complete',slug:'recovered',type:'TOPIC',canonicalUrl:'/community/topics/recovered'}],truncated:false,limit:20});
 if(path.endsWith('/topic_12345678-complete'))return Response.json({topic:{id:'topic_12345678-complete',slug:'recovered'}});
 return Response.json({error:{code:'TOPIC_NOT_FOUND',message:'Not found'}},{status:404});});
 assert.equal((await c.resolveTopic('12345678')).status,'UNRESOLVED');assert.equal(paths.length,1);
 assert.equal((await c.resolveTopic('12345678',{recoverPublicPrefix:true})).reference.id,'topic_12345678-complete');assert.equal(paths.length,4);
});
