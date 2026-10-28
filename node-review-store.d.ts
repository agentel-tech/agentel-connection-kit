import type {ReviewWorkerStore,ReviewWorkerSession} from './dist/review-worker.js';
export class NodeReviewWorkerStore implements ReviewWorkerStore {
 constructor(options:{directory:string;encryptionKey:Uint8Array;agentId:string;credentialBindingId:string;maxCheckpointBytes?:number});
 exclusive<T>(work:(session:ReviewWorkerSession)=>Promise<T>):Promise<T|null>;
}
