import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector} from '../dist/agentel-connector.js';
function fixture(status=200){
 const calls=[];
 const client=new AgentelConnector({agentId:'author',apiKey:'synthetic',baseUrl:'https://agentel.test/api/v1',maxRetries:4,fetch:async(url,init)=>{calls.push({url:String(url),method:init.method,body:init.body});return Response.json(status===200?{deleted:true}:{error:{code:'SERVER_FAILED',message:'Synthetic failure'}},{status});}});
 return {client,calls};
}
test('SDK exposes self-comment edit/delete separately from existing self-Post operations',async()=>{
 const {client,calls}=fixture();
 await client.editReply('post','reply','Corrected comment','Previous comment');await client.deleteReply('post','reply');await client.deleteUpdate('post');
 assert.equal(calls[0].url,'https://agentel.test/api/v1/updates/post/replies/reply');assert.equal(calls[0].method,'PATCH');assert.deepEqual(JSON.parse(calls[0].body),{content:'Corrected comment',expected_content:'Previous comment'});
 assert.equal(calls[1].method,'DELETE');assert.equal(calls[1].url,calls[0].url);assert.equal(calls[2].url,'https://agentel.test/api/v1/agents/author/updates/post');
});
for(const operation of ['editReply','deleteReply'])test(operation+' never automatically retries an uncertain write',async()=>{
 const {client,calls}=fixture(503);await assert.rejects(()=>operation==='editReply'?client.editReply('post','reply','Corrected'):client.deleteReply('post','reply'));assert.equal(calls.length,1);
});
test('SDK rejects invalid comment IDs and content before transport',()=>{
 const {client,calls}=fixture();
 for(const run of [()=>client.deleteReply('../post','reply'),()=>client.deleteReply('post',''),()=>client.editReply('post','reply',' '),()=>client.editReply('post','reply','x'.repeat(2001))])assert.throws(run);
 assert.equal(calls.length,0);
});
for(const operation of ['editReply','deleteReply'])test(operation+' never automatically retries a lost response',async()=>{
 let calls=0;
 const client=new AgentelConnector({agentId:'author',apiKey:'synthetic',baseUrl:'https://agentel.test/api/v1',maxRetries:4,fetch:async()=>{calls++;throw new Error('Synthetic transport failure');}});
 await assert.rejects(()=>operation==='editReply'?client.editReply('post','reply','Corrected'):client.deleteReply('post','reply'));
 assert.equal(calls,1);
});
for(const status of [408,429])for(const operation of ['editReply','deleteReply'])test(operation+' never retries '+status,async()=>{
 const {client,calls}=fixture(status);
 await assert.rejects(()=>operation==='editReply'?client.editReply('post','reply','Corrected'):client.deleteReply('post','reply'));
 assert.equal(calls.length,1);
});
