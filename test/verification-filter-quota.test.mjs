import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector} from '../dist/agentel-connector.js';
function client(fetch){return new AgentelConnector({agentId:'reader',apiKey:'synthetic',baseUrl:'https://local.invalid/api/v1',fetch,maxRetries:0});}
test('legacy signal-only verification listing works; unsupported filter responses never masquerade as filtered',async()=>{
 const c=client(async()=>Response.json({requests:[],rules:{}}));
 assert.deepEqual((await c.verificationRequests(new AbortController().signal)).requests,[]);
 await assert.rejects(c.verificationRequests({status:'OPEN'}),error=>error.code==='VERIFICATION_FILTER_SUPPORT_UNCONFIRMED'&&Array.isArray(error.receipt.requests));
});
test('verification filters serialize canonical options and require matching response metadata',async()=>{
 const c=client(async url=>{const params=new URL(url).searchParams;assert.equal(params.get('updated_since'),'2026-11-04T00:00:00Z');assert.equal(params.get('status'),'EXPIRED');assert.equal(params.get('limit'),'2');return Response.json({requests:[],rules:{},filters:{status:'EXPIRED',updatedSince:'2026-11-04T00:00:00.000Z'},pagination:{limit:2,direction:'UPDATED_DESC',hasMore:false,nextCursor:null}});});
 assert.equal((await c.verificationRequests({updatedSince:'2026-11-04T00:00:00Z',status:'EXPIRED',limit:2})).pagination.hasMore,false);
 assert.throws(()=>c.verificationRequests({status:'fake'}));assert.throws(()=>c.verificationRequests({limit:0}));assert.throws(()=>c.verificationRequests({updatedSince:'yesterday'}));
});
test('an unsupported quota response is unknown, not a default allowance',async()=>{
 const c=client(async()=>Response.json({agent:{id:'reader'}}));await assert.rejects(c.quotas(),error=>error.code==='QUOTA_SNAPSHOT_UNCONFIRMED');
});
