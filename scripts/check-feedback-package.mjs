// Local pack/consumer check only. Does not install, publish, read credentials or use the network.
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),temp=await mkdtemp(join(tmpdir(),'agentel-feedback-consumer-'));
try{
 const packResult=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',temp,'--cache',join(temp,'npm-cache')],{cwd:root,encoding:'utf8'}));
 const packed=Array.isArray(packResult)?packResult[0]:packResult['@agentel/sdk'];
 assert.ok(packed?.files,'npm pack returned no package manifest');
 const files=packed.files.map(f=>f.path);
 for(const expected of ['dist/source-access.js','dist/source-access.d.ts','FEEDBACK_API_GUIDE.md','examples/feedback/type-boundaries.ts','examples/feedback/source-cases.mjs'])assert.ok(files.includes(expected),'Missing '+expected);
 assert.ok(!files.some(name=>/(?:^|\/)(?:\.env(?:\.|$)|node_modules\/|.*receipt.*\.json$)/i.test(name)),'Unexpected environment/result file');
 const consumer=join(temp,'consumer'),installed=join(consumer,'node_modules','@agentel','sdk');await mkdir(installed,{recursive:true});
 execFileSync('tar',['-xzf',join(temp,packed.filename),'-C',installed,'--strip-components=1']);
 await writeFile(join(consumer,'package.json'),'{"type":"module"}');
 const examples=join(installed,'examples','feedback');
 for(const name of await readdir(examples))if(name.endsWith('.ts')||name==='source-cases.mjs'){
  const source=(await readFile(join(examples,name),'utf8')).replaceAll('../../dist/agentel-connector.js','@agentel/sdk');await writeFile(join(consumer,name),source);
 }
 await writeFile(join(consumer,'tsconfig.json'),await readFile(join(examples,'tsconfig.json')));
 execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p',join(consumer,'tsconfig.json')],{cwd:consumer,stdio:'pipe'});
 const output=JSON.parse(execFileSync(process.execPath,[join(consumer,'source-cases.mjs')],{cwd:consumer,encoding:'utf8'}));
 assert.equal(output.mode,'LOCAL_SYNTHETIC_NO_WRITES');assert.equal(output.coverage.findings,'UNKNOWN');assert.equal(output.attempts.blocked.state,'NOT_COVERED');
 console.log(`PASS: packed ${packed.files.length} files; strict NodeNext consumer examples, negative shape assertions and offline source cases. Version ${packed.version} remains unpublished.`);
}finally{await rm(temp,{recursive:true,force:true});}
