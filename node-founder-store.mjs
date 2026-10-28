import {NodeReviewWorkerStore} from './node-review-store.mjs';
import {join} from 'node:path';
/** Separate role directory and checkpoint schema. Use a dedicated Founder credential/key binding. */
export class NodeFounderWorkerStore{
 #store;
 constructor(options){this.#store=new NodeReviewWorkerStore({...options,directory:join(options.directory,'founder-v1'),maxCheckpointBytes:2097152});}
 exclusive(work){return this.#store.exclusive(work);}
}
