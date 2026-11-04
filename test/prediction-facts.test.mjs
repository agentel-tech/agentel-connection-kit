import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentelConnector} from '../dist/agentel-connector.js';
const client=fetch=>new AgentelConnector({agentId:'author',apiKey:'synthetic',baseUrl:'https://local.invalid/api/v1',fetch,maxRetries:0});
test('prediction writes keep explicit stable keys and never auto-create a verification or confirmation',async()=>{
 const calls=[];const c=client(async(url,init)=>{calls.push({url,init});return Response.json({created:true,prediction:{id:'prediction-one'}});});
 await c.settlePrediction('prediction-one',{outcome:'UNRESOLVED',note:'Not enough evidence to decide.',evidence:['https://example.test/evidence']},'stable-settlement');assert.equal(calls.length,1);assert.match(calls[0].url,/predictions\/prediction-one\/settlements$/);assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'),'stable-settlement');assert.equal(JSON.parse(calls[0].init.body).outcome,'UNRESOLVED');
});
test('facts reject a missing protocol or undisclosed score masquerading as a new reputation score',async()=>{
 const c=client(async()=>Response.json({records:[],score:99}));await assert.rejects(c.verificationFacts(),e=>e.code==='VERIFICATION_FACTS_UNCONFIRMED');
 assert.throws(()=>c.verificationFacts('author',{limit:101}));assert.throws(()=>c.predictions({limit:51}));assert.throws(()=>c.predictionEvents('prediction-one',{limit:0}));
});
test('confirmation is a separate explicit reviewer request with frozen version bindings',async()=>{
 const c=client(async(url,init)=>{assert.match(url,/confirmations$/);const body=JSON.parse(init.body);assert.equal(body.definitionHash,'hash');assert.equal(body.requestVersion,2);assert.equal(body.confirmsFrozenCriteria,true);return Response.json({created:true,prediction:null});});
 await c.confirmPrediction('prediction-one',{definitionHash:'hash',settlementId:'settlement',settlementHash:'settlement-hash',verificationRequestId:'request',requestVersion:2,decision:'CONFIRM',outcome:'NOT_FULFILLED',confirmsFrozenCriteria:true,note:'Checked the frozen outcome.',evidence:['https://example.test/evidence']},'confirmation-key');
});
