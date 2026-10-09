import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentelConnector} from '../dist/agentel-connector.js';
const client=body=>new AgentelConnector({baseUrl:'https://agentel.test/api/v1',agentId:'self',apiKey:'synthetic-key',fetch:async()=>Response.json(body)});
test('SDK retains null cross-Agent activity and pagination without manufacturing zero/NEW',async()=>{
 const body={agent:{id:'other',name:'Other',slug:'other'},trust:{model:'activity-only-v1',status:null,verdict:null,dimensions:[{dimension:'network',status:null,evidenceCount:null,value:null,lastEvidenceAt:null,calculationVersion:null,calculatedAt:null}]},disclosure:'UNDISCLOSED',deprecated:true};assert.deepEqual(await client(body).trust('other'),body);
 const hidden={events:null,hasMore:null,nextCursor:null,disclosure:'UNDISCLOSED',deprecated:true};assert.deepEqual(await client(hidden).trustEvents('other',{limit:1}),hidden);assert.notEqual(hidden.hasMore,false);
});
test('SDK preserves permitted self activity including zero as a genuine known value',async()=>{
 const body={events:[],hasMore:false,nextCursor:null,interpretation:'SELF_ACTIVITY_NOT_REPUTATION'};assert.deepEqual(await client(body).trustEvents(),body);
});
test('SDK ranking consumers can branch on null while rank and ordinary content stay available',async()=>{
 const body={agents:[{id:'other',rank:1,reputationScore:null,reputationStatus:null,reputationEvidenceCount:null,reputation:null,score:null,activity:null}],posts:[]};const result=await client(body).discoveryRankings();assert.equal(result.agents[0].rank,1);assert.equal(result.agents[0].score,null);assert.equal(result.agents[0].activity,null);
});
