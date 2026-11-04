import test from 'node:test';
import assert from 'node:assert/strict';
import {assessSourceAccess,sourceCoverage} from '../dist/agentel-connector.js';
const observedAt='2026-11-05T00:00:00Z';
const observe=extra=>assessSourceAccess({url:'https://example.test/release',observedAt,...extra});
test('AF07 HTTP failure, challenge, JS shell, binary data and no attempt never become no-change or verified facts',()=>{
 for(const [httpStatus,reason] of [[401,'AUTH_REQUIRED'],[403,'ACCESS_DENIED'],[429,'RATE_LIMITED'],[302,'REDIRECT_NOT_FOLLOWED'],[404,'HTTP_ERROR'],[503,'HTTP_ERROR']]){const r=observe({httpStatus,bodyText:'Readable looking error content'});assert.equal(r.state,'NOT_COVERED');assert.equal(r.reason,reason);assert.equal(r.claimsSupported,false);}
 assert.equal(observe({httpStatus:200,contentType:'text/html',bodyText:'<html><head><title>News</title></head><body><div id="root"></div><script>load()</script></body></html>'}).reason,'EMPTY_OR_SCRIPT_SHELL');
 assert.equal(observe({httpStatus:200,bodyText:'Verify you are human to continue.'}).reason,'ACCESS_DENIED');assert.equal(observe({httpStatus:200,contentType:'application/pdf',bodyText:'%PDF-1.0 bytes'}).reason,'EXTRACTION_REQUIRED');
 assert.equal(observe({failure:'TIMEOUT'}).reason,'TIMEOUT');assert.equal(observe({failure:'NETWORK_ERROR'}).state,'NOT_COVERED');assert.equal(observe({}).reason,'NOT_ATTEMPTED');
});
test('AF07 readable alternatives remain unverified, contain no body, and cannot imply complete provider coverage',()=>{
 const failed=observe({httpStatus:403}),readable=observe({httpStatus:200,contentType:'text/plain',bodyText:'A source contains one bounded observation.'});assert.equal(readable.state,'READABLE');assert.equal(readable.verification,'UNVERIFIED');assert.equal(readable.claimsSupported,false);assert.equal('bodyText' in readable,false);
 const result=sourceCoverage([failed,readable]);assert.equal(result.state,'READABLE_SOURCE_AVAILABLE');assert.equal(result.completeProviderCoverage,false);assert.equal(result.findings,'UNKNOWN');assert.equal(result.failedSources.length,1);
 assert.equal(sourceCoverage([]).state,'NOT_COVERED');assert.equal(observe({httpStatus:200,contentType:'application/pdf',extractedText:'Explicit text supplied by an authorized extraction tool.'}).state,'READABLE');
});
test('AF07 invalid/private/credential URLs and observation times fail explicitly',()=>{
 for(const url of ['http://example.test','https://u:secret@example.test','https://127.0.0.1/a','https://192.168.1.1/a','https://example.test/?access_token=secret','https://example.test/#access_token=secret'])assert.throws(()=>assessSourceAccess({url,observedAt,httpStatus:200,bodyText:'text'}));
 assert.throws(()=>observe({observedAt:'yesterday'}));assert.throws(()=>observe({httpStatus:600}));
});
