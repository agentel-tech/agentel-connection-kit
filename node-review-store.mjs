import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdirSync,chmodSync,lstatSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';

/** Operator adapter requiring node:sqlite. Supply a dedicated directory and a broker-injected 32-byte key; never put the key in a model prompt or file. */
export class NodeReviewWorkerStore{
 #directory; #key; #aad; #maxBytes;
 constructor({directory,encryptionKey,agentId,credentialBindingId,maxCheckpointBytes=65536}){
  if(!(encryptionKey instanceof Uint8Array)||encryptionKey.byteLength!==32||![agentId,credentialBindingId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)))throw Error('INVALID_ENCRYPTED_STORE_CONFIGURATION');
  if(!Number.isInteger(maxCheckpointBytes)||maxCheckpointBytes<65536||maxCheckpointBytes>2097152)throw Error('INVALID_CHECKPOINT_BOUND');this.#maxBytes=maxCheckpointBytes;
  this.#directory=resolve(directory);this.#key=Buffer.from(encryptionKey);this.#aad=Buffer.from(JSON.stringify(['agentel-review-worker/v1',agentId,credentialBindingId]));
  mkdirSync(this.#directory,{recursive:true,mode:0o700});if(lstatSync(this.#directory).isSymbolicLink())throw Error('STORE_SYMLINK_FORBIDDEN');chmodSync(this.#directory,0o700);
 }
 async exclusive(work){
  const lockPath=join(this.#directory,'review-worker.lock.sqlite'),statePath=join(this.#directory,'review-worker.state.sqlite');
  for(const path of [lockPath,statePath])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('STORE_SYMLINK_FORBIDDEN');
  const lock=new DatabaseSync(lockPath);chmodSync(lockPath,0o600);lock.exec('PRAGMA busy_timeout=0;');
  try{lock.exec('BEGIN EXCLUSIVE;');}catch(e){lock.close();if(e.code==='ERR_SQLITE_ERROR'&&/locked|busy/.test(e.message))return null;throw e;}
  let state;
  try{
   // A separate DB commits each pending request durably while the process lease stays locked.
   state=new DatabaseSync(statePath);chmodSync(statePath,0o600);state.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), envelope BLOB NOT NULL);');
   return await work({load:async()=>{
    const row=state.prepare('SELECT envelope FROM checkpoint WHERE id=1').get();if(!row)return null;
    try{const bytes=Buffer.from(row.envelope),iv=bytes.subarray(0,12),tag=bytes.subarray(12,28),cipher=bytes.subarray(28);const decipher=createDecipheriv('aes-256-gcm',this.#key,iv);decipher.setAAD(this.#aad);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(cipher),decipher.final()]).toString('utf8'));}catch{throw Error('CHECKPOINT_AUTHENTICATION_FAILED');}
   },save:async value=>{
    const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>this.#maxBytes)throw Error('CHECKPOINT_TOO_LARGE');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(this.#aad);const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
    state.prepare('INSERT INTO checkpoint(id,envelope) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope').run(Buffer.concat([iv,cipher.getAuthTag(),encrypted]));
   }});
  }finally{state?.close();lock.exec('ROLLBACK;');lock.close();}
 }
}
