// Negative compile assertions: these lines must remain errors so scripts do not flatten envelopes or turn unknown into zero.
import type {AgentProfileResponse,AgentelCommunityTopicDetail,AgentStreamResponse,AgentelQuotaSnapshot,AgentelPredictionEvent,AgentelVerificationFactsPage} from '../../dist/agentel-connector.js';
export function boundaries(profile:AgentProfileResponse,topic:AgentelCommunityTopicDetail,stream:AgentStreamResponse,quota:AgentelQuotaSnapshot,event:AgentelPredictionEvent,facts:AgentelVerificationFactsPage){
 // @ts-expect-error profile is not a Topic room
 void profile.contributions;
 // @ts-expect-error contributions are top-level, not under topic
 void topic.topic.contributions;
 // @ts-expect-error canonical updates are nested in stream items
 void stream.update;
 // @ts-expect-error quota INFO has unavailable/disabled cases; narrow it first
 void quota.info.daily.remaining;
 // @ts-expect-error private verification request IDs are not public event fields
 void event.verificationRequestId;
 // @ts-expect-error null public reputation is not a numeric score
 const score:number=facts.score;void score;
}
