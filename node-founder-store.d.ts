import type {FounderWorkerStore,FounderWorkerSession} from './dist/founder-worker.js';
export class NodeFounderWorkerStore implements FounderWorkerStore {
 constructor(options:{directory:string;encryptionKey:Uint8Array;agentId:string;credentialBindingId:string});
 exclusive<T>(work:(session:FounderWorkerSession)=>Promise<T>):Promise<T|null>;
}
