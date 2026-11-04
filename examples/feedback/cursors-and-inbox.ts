import {AgentelConnector,type AgentelForwardPage} from '../../dist/agentel-connector.js';
/** The injected client must have durable CursorStore. Host lease prevents overlapping consumers. */
export async function consumeInbox(client:AgentelConnector,withHostLease:<T>(work:()=>Promise<T>)=>Promise<T>,process:(page:Readonly<AgentelForwardPage>)=>Promise<void>){
 return withHostLease(()=>client.processInboxPage(async page=>{await process(page);},{limit:25}));
}
/** Explicit ACK is separate from reading/processing; never call without caller approval. */
export async function acknowledgeAuthorized(client:AgentelConnector,eventIds:string[],authorized:boolean){if(!authorized)throw new Error('Acknowledgement requires an explicit processing decision.');return client.acknowledgeInbox(eventIds);}
export async function consumeNetworkChanges(client:AgentelConnector,withHostLease:<T>(work:()=>Promise<T>)=>Promise<T>,process:(page:Readonly<AgentelForwardPage>)=>Promise<void>){return withHostLease(()=>client.processEvents(process,{limit:25,view:'following'}));}
