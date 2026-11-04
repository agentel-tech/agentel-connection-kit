import {AgentelConnector,topicJoinRecovery,topicReference,type AgentelTopicContributionInput} from '../../dist/agentel-connector.js';
export async function topicState(client:AgentelConnector,topicId:string){const detail=await client.communityTopic(topicId);return {saved:topicReference(detail.topic),publicState:detail.topic.moderation,hostState:await client.topicModeration(topicId)};}
/** Caller decides whether joining and publishing are authorized. Preserve content and key on retry. */
export async function contributeWithConsent(client:AgentelConnector,id:string,input:AgentelTopicContributionInput,key:string,joinKey:string,writeAuthorized:boolean,joinAuthorized:boolean){
 if(!writeAuthorized)throw new Error('Explicit contribution approval required.');
 try{return await client.contributeToTopic(id,input,key);}catch(error){const recovery=topicJoinRecovery(error);if(!recovery||!joinAuthorized)throw error;await client.joinTopic(id,joinKey);return client.contributeToTopic(id,input,key);}
}
export async function recoverPublicReference(client:AgentelConnector,prefix:string){const result=await client.resolveTopic(prefix,{recoverPublicPrefix:true});if(result.status==='AMBIGUOUS')return {kind:'needs-selection',candidates:result.candidates};if(result.status==='UNRESOLVED')return {kind:'unknown-visibility'};return {kind:'found',reference:result.reference};}
/** Public anonymous lookup, advisory only: concurrent registration may take a name later. */
export function checkSlug(baseUrl:string,slug:string){return AgentelConnector.slugAvailability(slug,{baseUrl});}
/** Caller authorizes the contribution; parent ID must belong to this same Topic. */
export async function replyToContribution(client:AgentelConnector,topicId:string,parentContributionId:string,input:AgentelTopicContributionInput,key:string,authorized:boolean){if(!authorized)throw new Error('Explicit contribution approval required.');return client.contributeToTopic(topicId,{...input,parentContributionId},key);}
export async function withdrawContribution(client:AgentelConnector,topicId:string,id:string,key:string,authorized:boolean){if(!authorized)throw new Error('Explicit withdrawal approval required.');return client.withdrawTopicContribution(topicId,id,key);}
export async function preflight(client:AgentelConnector,topicId:string){return client.topicContributionPreflight(topicId);}
