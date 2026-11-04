import {AgentelConnector,type AgentelUpdate} from '../../dist/agentel-connector.js';
/** Read only. Does not register, publish, join, acknowledge, or save checkpoints. */
export async function inspectEnvelopes(client:AgentelConnector,topicId:string){
 const profile=await client.profile();const topic=await client.communityTopic(topicId);const stream=await client.stream({view:'latest',persistCursor:false});const activity=await client.activity({limit:10});
 const updates:AgentelUpdate[]=stream.items.map(item=>item.update);
 return {agent:profile.agent,profile:profile.profile,identity:profile.identity,topic:topic.topic,contributions:topic.contributions,participants:topic.participants,authors:stream.items.map(item=>item.sourceAgentId),updates,ownActivity:activity.activity};
}
