import {extendedFounderActions,creationInvitationActions} from './founder-actions.js';
import {AgentelApiError,type AgentelConnector,type AgentelMissionWorkspace} from './agentel-connector.js';
export type FounderPreparationOperation='ACCEPT_CREATION_REQUEST'|'SUBMIT_CREATION_DRAFT'|'PUBLISH_APPROVED_MISSION'|'INVITE_CREATION_AGENT'|'CANCEL_CREATION_INVITATION';
export type FounderPreparationContext={inputTrust:'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS';request:Record<string,unknown>;discussion:Record<string,unknown>;rejections:FounderRejection[];actions:Array<{id:string;operation:FounderPreparationOperation;binding?:Record<string,unknown>}>};
export type FounderOperation='SELECT_APPLICATIONS'|'ACTIVATE_ASSIGNMENT'|'SEND_ROOM_MESSAGE'|'OUTCOME_OPINION'|'FINAL_CANDIDATE'|'INVITE_CANDIDATES'|'REPLACE_ASSIGNMENT'|'RETRY_REVIEW'|'INTERNAL_CHECK';
export type FounderAction={id:string;operation:FounderOperation;targetId?:string;binding?:Record<string,unknown>};
export type FounderContext={inputTrust:'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS';workspace:AgentelMissionWorkspace;contract:Record<string,unknown>;applications:Record<string,unknown>;deliveries:Record<string,unknown>;room:Record<string,unknown>;actions:FounderAction[];invitations?:Record<string,unknown>;rejections?:FounderRejection[]};
export type FounderRejection={missionId:string;operation:FounderOperation|FounderPreparationOperation;resourceKind?:'CREATION_REQUEST';targetId?:string;issues?:Array<{path:string;code:string;suggestedValue?:number}>;key:string;bodyHash:string;basisHash:string|null;code:string;status:number;rejectedAt:string};
export type FounderIssue={id:string;resourceId:string;resourceKind:'MISSION'|'CREATION_REQUEST';code:string;status:number;operationKeyHash:string};
type Pending={failure?:{code:string;status:number;runs:number;lastRun:string};quarantined?:boolean;quarantineReason?:'UNRESOLVED_REJECTION';issue?:FounderIssue;noticeRecorded?:boolean;retryAt?:number;basisHash?:string;resourceKind?:'CREATION_REQUEST';missionId:string;operation:FounderOperation|FounderPreparationOperation;targetId?:string;body:Record<string,unknown>;key:string};
export type FounderWorkerState={schema:1;role:'FOUNDER';agentId:string;notBefore:number;cursor:number;pending:Pending|null;rejections?:FounderRejection[];deferred?:Pending[];followedMissions?:Array<{requestId:string;missionId:string}>};
export type FounderWorkerSession={load():Promise<FounderWorkerState|null>;save(state:FounderWorkerState):Promise<void>};
export type FounderWorkerStore={exclusive<T>(work:(session:FounderWorkerSession)=>Promise<T>):Promise<T|null>};
export type FounderDecision={actionId:string;body:Record<string,unknown>}|{wait:true};
export type FounderWorkerOptions={agentId:string;client:AgentelConnector;store:FounderWorkerStore;
 judge:{ready(signal:AbortSignal):Promise<boolean>;decide(context:Readonly<FounderContext>,signal:AbortSignal):Promise<FounderDecision>;prepare?(context:Readonly<FounderPreparationContext>,signal:AbortSignal):Promise<FounderDecision>};
 /** Operator role-specific liveness port, not the reviewer-only heartbeat route. No business authority. */
 contact(metadata:{role:'FOUNDER';state:'START'|'ACTIVE'|'END';missionId:string|null},signal:AbortSignal):Promise<void>;
 /** Ordinary authenticated notification API by default; injected ports must durably alert both audiences. */
 reportIssue?(issue:FounderIssue,signal:AbortSignal):Promise<void>;
 now?:()=>number;random?:()=>number};
export type FounderWorkerRun={missionIds:string[];creationRequestIds?:string[];candidateAgentIds?:string[];maxMissions:number;maxSteps:number;maxRunMs:number;signal?:AbortSignal};
const fail=(code:string)=>Object.assign(new Error(code),{code});
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw fail('INVALID_FOUNDER_INPUT');return v as Record<string,unknown>;};
const rows=(v:unknown)=>Array.isArray(v)?v.map(record):[];
const exact=(o:Record<string,unknown>,keys:string[])=>{if(Object.keys(o).some(k=>!keys.includes(k)))throw fail('INVALID_FOUNDER_DECISION');};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const note=(v:unknown,max=4000)=>typeof v==='string'&&v.trim().length>=4&&v.length<=max;
const hash=async(v:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))).map(n=>n.toString(16).padStart(2,'0')).join('');
// Only known business denials are terminal. Auth, key collision, generic HTTP errors,
// timeouts/rate limits and server failures may hide a prior commit and must retain the key.
const rejectionCodes=new Set([
 'MISSION_CREATION_LIMIT','MISSION_DRAFT_NOT_EDITABLE','MISSION_CREATION_REQUEST_NOT_FOUND','OFFICIAL_MISSION_BUDGET_NOT_FOUND','OFFICIAL_MISSION_BUDGET_NOT_PROVISIONED','OFFICIAL_MISSION_BUDGET_DISABLED','OFFICIAL_MISSION_PLAN_EXCEEDED','OFFICIAL_MISSION_SCOPE_EXCEEDED','OFFICIAL_MISSION_REQUEST_REQUIRED','OWNED_COLLABORATION_NOT_ENABLED','OWNED_COLLABORATION_SCOPE_REQUIRED','OWNED_COLLABORATION_OWNER_CHANGED','OWNED_COLLABORATION_CLOSED','OWNED_COLLABORATION_AUTHORITY_CHANGED','OWNED_COLLABORATION_ACCESS_REQUIRED','OWNED_COLLABORATION_CONTRACT_REQUIRED','INVALID_OWNED_MODE','CUSTOMER_FOUNDER_REQUIRED','MISSION_REQUEST_ACCESS_INVALID','MISSION_ACCESS_CONTRACT_MISMATCH','MISSION_AUTHORITY_MISMATCH','MISSION_AUTHORITY_CHANGED','MISSION_CREATION_CONTRACT_MISSING','FOUNDER_ENTITLEMENT_REQUIRED','FOUNDER_ACCOUNT_REQUIRED',
 'INVALID_MISSION_CONTRACT','MISSION_POOL_POLICY_REPAIR_REQUIRED','MISSION_PHASE_TIMING_REQUIRED','MISSION_CREATION_REQUEST_NOT_READY','MISSION_CREATION_REQUEST_NOT_ACCEPTABLE','MISSION_DRAFT_CHANGED','MISSION_CREATION_DRAFT_EXISTS','MISSION_SLUG_TAKEN',
 'INVALID_SELECTIONS','DUPLICATE_APPLICATION_SELECTION','APPLICATION_NOT_FOUND','APPLICATION_NOT_ELIGIBLE_FOR_SELECTION',
 'INTERNAL_CHECKER_OWNER_REQUIRED','MISSION_SLOT_NOT_FOUND','SELECTION_RATIONALE_TOO_LONG','MISSION_SLOT_CAPACITY_CONFLICT','MISSION_STAFFING_CLOSED','REVIEW_IS_POOL_ROUTED',
 'ASSIGNMENT_NOT_FOUND','ASSIGNMENT_NOT_READY','MISSION_STAGE_NOT_FOUND','MISSION_STAGE_DEPENDENCY_MANAGED','MISSION_REVIEW_COVERAGE_REQUIRED','ASSIGNMENT_ACTIVATION_CONFLICT',
 'INVALID_ROOM_MESSAGE','INVALID_ROOM_MESSAGE_TYPE','INVALID_ROOM_AUDIENCE','ROOM_MESSAGE_METADATA_TOO_LARGE','ROOM_STAGE_REQUIRED','ROOM_ASSIGNMENT_REQUIRED',
 'ROOM_AUDIENCE_SHAPE_INVALID','MISSION_ROOM_NOT_READY','MISSION_ROOM_MESSAGE_CONFLICT','INVALID_OUTCOME_OPINION','POOL_OUTCOME_VERSION_REQUIRED',
 'POOL_OUTCOME_VERSION_CHANGED','MISSION_OUTCOME_NOT_READY','MISSION_OUTCOME_NOT_YOUR_TURN','POOL_OUTCOME_POLICY_REPAIR_REQUIRED','POOL_OUTCOME_CHANGED',
 'MISSION_OUTCOME_OPINION_CONFLICT','INVALID_CANDIDATE_PREDECESSOR','INVALID_FINAL_MATERIAL','FINAL_MATERIAL_PLACEHOLDER','FINAL_MATERIAL_CHANGED',
 'FINAL_MATERIAL_HISTORY_UNAVAILABLE','FINAL_MATERIAL_PUBLIC_ONLY','FINAL_MATERIAL_SOURCES_REQUIRED','FINAL_MATERIAL_SOURCE_UNAVAILABLE','FINAL_MATERIAL_TOO_LARGE',
 'FINAL_CANDIDATE_CHANGED','FINAL_CANDIDATE_SCOPE_REQUIRED','FINAL_CANDIDATE_AGREEMENT_REQUIRED','FINAL_CANDIDATE_REQUIRED','MISSION_OUTCOME_ALREADY_PUBLISHED',
]);
const terminalRejection=(e:unknown):e is AgentelApiError=>e instanceof AgentelApiError&&[400,402,403,404,409,410,422].includes(e.status)&&e.retryAfterMs===null&&rejectionCodes.has(e.code);
function structuredDenial(e:unknown):e is AgentelApiError {
 if(!(e instanceof AgentelApiError)||e.status<400||e.status>=500||[408,429].includes(e.status)||e.retryAfterMs!==null)return false;
 const envelope=e.details&&typeof e.details==='object'?e.details as Record<string,unknown>:null;
 const error=envelope?.error&&typeof envelope.error==='object'?envelope.error as Record<string,unknown>:null;
 return typeof error?.code==='string'&&error.code===e.code&&/^[A-Z0-9_]{1,100}$/.test(error.code);
}
const basis=(context:FounderContext|FounderPreparationContext)=>hash({...context,rejections:undefined});
function rejectionIssues(details:unknown):Array<{path:string;code:string;suggestedValue?:number}>{
 const envelope=details&&typeof details==='object'?details as Record<string,unknown>:null;
 const error=envelope?.error&&typeof envelope.error==='object'?envelope.error as Record<string,unknown>:null;
 const data=error?.details??details,d=data&&typeof data==='object'?data as Record<string,unknown>:null;
 const items=Array.isArray(data)?data:Array.isArray(d?.issues)?d.issues:[];
 return items.slice(0,8).flatMap(value=>{
  if(!value||typeof value!=='object')return [];const issue=value as Record<string,unknown>;
  if(typeof issue.path!=='string'||!/^[A-Za-z0-9_$.[\]-]{1,180}$/.test(issue.path))return [];
  const code=typeof issue.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(issue.code)?issue.code:'DRAFT_FIELD_INVALID';
  return [{path:issue.path,code,...(typeof issue.suggestedValue==='number'&&Number.isFinite(issue.suggestedValue)?{suggestedValue:issue.suggestedValue}:{})}];
 });
}
function control(workspace:AgentelMissionWorkspace){if(!workspace.founderControl)throw fail('FOUNDER_AUTHORITY_REQUIRED');return record(workspace.founderControl);}
function actions(workspace:AgentelMissionWorkspace):FounderAction[]{
 const c=control(workspace),a:FounderAction[]=[];
 if(['RESULT_PUBLISHED','OUTCOME_ACCEPTED'].includes(workspace.state)||['CANCELLED','COMPLETED','FAILED'].includes(workspace.mission.status))return a;
 const outcome=c.outcomeNextAction?record(c.outcomeNextAction):null;
 if(outcome?.action==='WAIT_FOR_HUMAN_FINAL_DECISION')return a;
 if(outcome?.actor==='FOUNDER_AGENT'&&outcome.method==='POST'){
  if(Array.isArray(outcome.allowedDecisions)&&outcome.allowedDecisions.includes('AGREE'))a.push({id:'opinion',operation:'OUTCOME_OPINION'});
  else if(['PREPARE_FIXED_FINAL_CANDIDATE','CONFIRM_EDITED_FINAL_CANDIDATE'].includes(String(outcome.action)))a.push({id:'final',operation:'FINAL_CANDIDATE'});
 }
 if(workspace.mission.status==='OPEN')for(const app of rows(c.applications))if(app.status==='ELIGIBILITY_PASSED'&&app.contractHash===workspace.mission.contractHash&&app.contractVersion===workspace.mission.contractVersion&&id(app.id))a.push({id:'select:'+app.id,operation:'SELECT_APPLICATIONS',targetId:app.id});
 for(const assignment of rows(c.assignments))if(id(assignment.id)&&rows(assignment.nextActions).some(n=>n.type==='ACTIVATE_ASSIGNMENT'))a.push({id:'activate:'+assignment.id,operation:'ACTIVATE_ASSIGNMENT',targetId:assignment.id});
 // Coordination uses only the normal Mission room. No arbitrary endpoint or direct-message authority.
 if(Number(record(c.summary??{}).blocked??0)>0||rows(c.assignments).some(a=>record(a.sla??{}).state==='INPUT_PAUSED'))a.push({id:'coordinate',operation:'SEND_ROOM_MESSAGE'});return a;
}
function bodyFor(action:FounderAction,value:unknown,context:FounderContext){
 const b=record(value),c=control(context.workspace),outcome=c.outcomeNextAction?record(c.outcomeNextAction):{},internal=context.deliveries.reviewMode==='INTERNAL_CHECK'&&!!context.deliveries.internalCheck;
 switch(action.operation){
 case 'INVITE_CANDIDATES':{
  exact(b,['candidateAgentIds','note']);const permitted=action.binding?.candidateAgentIds;
  if(!Array.isArray(b.candidateAgentIds)||b.candidateAgentIds.length<1||b.candidateAgentIds.length>6||new Set(b.candidateAgentIds).size!==b.candidateAgentIds.length||!Array.isArray(permitted)||!b.candidateAgentIds.every(v=>id(v)&&permitted.includes(v))||!note(b.note,2000))throw fail('INVALID_FOUNDER_DECISION');
  const binding={...action.binding};delete binding.candidateAgentIds;return {...binding,candidate_agent_ids:b.candidateAgentIds,reason:b.note};
 }
 case 'REPLACE_ASSIGNMENT':exact(b,['note']);if(!note(b.note,2000))throw fail('INVALID_FOUNDER_DECISION');return {...action.binding,evidence:{...record(action.binding?.evidence),founderReviewNote:b.note}};
 case 'RETRY_REVIEW':exact(b,[]);return {...action.binding};
 case 'INTERNAL_CHECK':exact(b,['decision','note']);if(!['ACCEPTED','REVISION_REQUESTED','REJECTED'].includes(String(b.decision))||!note(b.note))throw fail('INVALID_FOUNDER_DECISION');return b;
 case 'SELECT_APPLICATIONS':
  exact(b,['decision','rationale']);if(!['SELECTED','WAITLISTED','NOT_SELECTED'].includes(String(b.decision))||!note(b.rationale,2000))throw fail('INVALID_FOUNDER_DECISION');
  return {selections:[{application_id:action.targetId,decision:b.decision,rationale:b.rationale}]};
 case 'ACTIVATE_ASSIGNMENT':exact(b,[]);return {};
 case 'OUTCOME_OPINION':
  exact(b,['decision','note']);if(internal&&['AGREE','DISAGREE'].includes(String(b.decision))&&note(b.note))return b;
  if(!['AGREE','DISAGREE'].includes(String(b.decision))||!note(b.note)||typeof outcome.expected_review_set_hash!=='string'||!Number.isInteger(outcome.expected_round))throw fail('INVALID_FOUNDER_DECISION');
  return {...b,expected_review_set_hash:outcome.expected_review_set_hash,expected_round:outcome.expected_round};
 case 'FINAL_CANDIDATE':
  exact(b,['finalMaterial']);record(b.finalMaterial);if(internal)return {...b,expectedCandidateId:outcome.expectedCandidateId??null};
  if(typeof outcome.expected_review_set_hash!=='string')throw fail('INVALID_FOUNDER_DECISION');
  return {...b,expectedCandidateId:outcome.expectedCandidateId??null,expected_review_set_hash:outcome.expected_review_set_hash};
 case 'SEND_ROOM_MESSAGE':
  exact(b,['message_type','audience_type','content','stage_id','assignment_id']);if(!['CHAT','HANDOFF_PROPOSAL','QUESTION','DECISION_REQUEST'].includes(String(b.message_type))||!['ROOM','STAGE','ASSIGNMENT'].includes(String(b.audience_type))||!note(b.content,12000))throw fail('INVALID_FOUNDER_DECISION');return b;
 }
}
/** Operator supplies the explicit owned Mission inventory. No arbitrary model tools or Human decisions. */
export async function runFounderWorker(o:FounderWorkerOptions,run:FounderWorkerRun){
 if(!id(o.agentId)||o.client.currentAgentId!==o.agentId||!Array.isArray(run.missionIds)||run.missionIds.length>50||new Set(run.missionIds).size!==run.missionIds.length||!run.missionIds.every(id)||!Number.isInteger(run.maxMissions)||run.maxMissions<1||run.maxMissions>10||!Number.isInteger(run.maxSteps)||run.maxSteps<1||run.maxSteps>20||!Number.isFinite(run.maxRunMs)||run.maxRunMs<1||run.maxRunMs>21600000)throw fail('INVALID_FOUNDER_CONFIGURATION');
 const requestIds=run.creationRequestIds??[],missionIds=[...run.missionIds],candidateIds=run.candidateAgentIds??[];
 if(!Array.isArray(candidateIds)||candidateIds.length>50||!candidateIds.every(id)||new Set(candidateIds).size!==candidateIds.length)throw fail('INVALID_FOUNDER_CONFIGURATION');
 if(!Array.isArray(requestIds)||requestIds.length>50||!requestIds.every(id)||new Set(requestIds).size!==requestIds.length)throw fail('INVALID_FOUNDER_CONFIGURATION');
 const inventory=[...requestIds.map(id=>({id,kind:'CREATION_REQUEST' as const})),...run.missionIds.map(id=>({id,kind:'MISSION' as const}))];
 if(inventory.length>50)throw fail('INVALID_FOUNDER_CONFIGURATION');
 const now=o.now??Date.now,client=o.client.forFounderWorker();
 return await o.store.exclusive(async store=>{
  let s=await store.load();if(s&&(s.schema!==1||s.role!=='FOUNDER'||s.agentId!==o.agentId))throw fail('FOUNDER_CHECKPOINT_MISMATCH');
  s??={schema:1,role:'FOUNDER',agentId:o.agentId,notBefore:0,cursor:0,pending:null};
  if(s.notBefore>now())return {status:'WAIT_NEXT_CHECK',completed:0,rejected:0,missionIssues:[],code:null,nextCheckAt:s.notBefore};
  const controller=new AbortController(),stop=()=>controller.abort();run.signal?.addEventListener('abort',stop,{once:true});if(run.signal?.aborted)stop();
  const deadline=now()+run.maxRunMs,timer=setTimeout(stop,run.maxRunMs);let completed=0,rejected=0,attempts=0,lastContact=now(),missionId:string|null=null,ready=false;
  const runId=crypto.randomUUID();s.deferred??=[];
  // Membership is local routing metadata, not a business receipt. Removed request inventories must not accumulate forever.
  s.followedMissions=(s.followedMissions??[]).filter(f=>requestIds.includes(f.requestId));
  const sameResource=(a:Pending,b:{missionId:string;resourceKind?:'CREATION_REQUEST'})=>a.missionId===b.missionId&&a.resourceKind===b.resourceKind;
  const missionIssues:Array<{missionId:string;code:string}>=[];
  const follow=(requestId:string,mid:string)=>{
   if(!id(mid)||!requestIds.includes(requestId))throw fail('FOUNDER_FOLLOW_BINDING_INVALID');
   s!.followedMissions??=[];const prior=s!.followedMissions.find(x=>x.requestId===requestId);
   if(prior&&prior.missionId!==mid)throw fail('FOUNDER_FOLLOW_BINDING_CHANGED');
   if(!prior){if(s!.followedMissions.length>=50)throw fail('FOUNDER_FOLLOW_CAPACITY');s!.followedMissions.push({requestId,missionId:mid});}
   if(!missionIds.includes(mid)){
    if(inventory.length>=50){missionIssues.push({missionId:mid,code:'FOUNDER_INVENTORY_CAPACITY'});return;}
    missionIds.push(mid);inventory.push({id:mid,kind:'MISSION'});
   }
  };

  const check=()=>{if(controller.signal.aborted||now()>=deadline)throw fail('RUN_BUDGET_EXHAUSTED');};
  const save=()=>store.save(s!);
  const contact=async(state:'START'|'ACTIVE'|'END')=>{check();await o.contact({role:'FOUNDER',state,missionId},controller.signal);lastContact=now();};
  const pulse=async()=>{if(now()-lastContact>=1800000)await contact('ACTIVE');};
  const bounded=async<T>(work:()=>Promise<T>):Promise<T>=>{
   check();let abort:()=>void=()=>{};
   try{return await Promise.race([new Promise<never>((_,reject)=>{abort=()=>reject(fail('RUN_BUDGET_EXHAUSTED'));controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();}),work()]);}
   finally{controller.signal.removeEventListener('abort',abort);}
  };
  const replay=async()=>{
   const p=s!.pending!;if(!(p.resourceKind==='CREATION_REQUEST'?requestIds:missionIds).includes(p.missionId)){s!.deferred=[...(s!.deferred??[]).filter(q=>!sameResource(q,p)),p];s!.pending=null;await save();missionIssues.push({missionId:p.missionId,code:'PENDING_MISSION_OUTSIDE_INVENTORY'});return;}
   if(attempts>=run.maxSteps)throw fail('FOUNDER_STEP_LIMIT');attempts++;
   try{const result=await bounded(()=>p.resourceKind==='CREATION_REQUEST'?client.executeFounderPreparation(p.missionId,p.operation as FounderPreparationOperation,p.body,p.key,controller.signal):client.executeFounderOperation(p.missionId,p.operation as FounderOperation,p.body,p.key,p.targetId,controller.signal));
    if(p.operation==='PUBLISH_APPROVED_MISSION'){const r=record(result),m=record(r.mission);if(r.published!==true||m.id!==p.body.mission_id||m.contractHash!==p.body.contract_hash||m.contractVersion!==p.body.contract_version)throw fail('FOUNDER_PUBLICATION_RECEIPT_UNCONFIRMED');follow(p.missionId,String(m.id));}
   }
   catch(e){
    if(!terminalRejection(e)||e.code==='MISSION_CREATION_LIMIT'){
     const explicit=structuredDenial(e),prior=p.failure;
     const runs=explicit?(prior?.runs??0)+(prior?.lastRun===runId?0:1):0;
     p.failure={code:e instanceof AgentelApiError?e.code:'TRANSPORT_OUTCOME_UNKNOWN',status:e instanceof AgentelApiError?e.status:0,runs,lastRun:runId};
     if(e instanceof AgentelApiError&&e.retryAfterMs!==null)p.retryAt=now()+e.retryAfterMs;
     if(explicit&&runs>=2){p.quarantined=true;p.quarantineReason='UNRESOLVED_REJECTION';p.issue={id:'founder_issue_'+crypto.randomUUID(),resourceId:p.missionId,resourceKind:p.resourceKind??'MISSION',code:e.code,status:e.status,operationKeyHash:await hash(p.key)};}
     s!.deferred=[...(s!.deferred??[]).filter(q=>!sameResource(q,p)),p];s!.pending=null;await save();
     missionIssues.push({missionId:p.missionId,code:p.quarantined?'UNRESOLVED_REJECTION':p.failure.code});return;
    }
    const rejection:FounderRejection={missionId:p.missionId,operation:p.operation,...(p.resourceKind?{resourceKind:p.resourceKind}:{}),...((p.operation==='SUBMIT_CREATION_DRAFT'&&rejectionIssues(e.details).length)?{issues:rejectionIssues(e.details)}:{}),...(p.targetId?{targetId:p.targetId}:{}),key:p.key,bodyHash:await hash(p.body),basisHash:p.basisHash??null,code:e.code,status:e.status,rejectedAt:new Date(now()).toISOString()};
    // Clear the pending intent only in the same durable checkpoint as its rejection record.
    s!.rejections=[...(s!.rejections??[]).map(({issues:oldIssues,...metadata})=>{void oldIssues;return metadata;}),rejection].slice(-32);s!.pending=null;await save();rejected++;return;
   }
   s!.pending=null;completed++;await save();
  };
  const read=async(mid:string):Promise<FounderContext>=>{
   const workspace=await bounded(()=>client.missionWorkspace(mid,controller.signal));if(workspace.mission.id!==mid)throw fail('MISSION_ID_MISMATCH');control(workspace);
   const contract=await bounded(()=>client.founderMissionContract(mid,controller.signal));
   if(record(contract.mission).contractHash!==workspace.mission.contractHash)throw fail('FOUNDER_CONTEXT_CHANGED');
   const applications=await bounded(()=>client.missionApplications(mid,controller.signal));
   const deliveries=await bounded(()=>client.missionDeliveries(mid,controller.signal));let room:Record<string,unknown>;
   try{room=await bounded(()=>client.missionRoom(mid,{limit:100,signal:controller.signal}));}
   catch(e){if(e instanceof AgentelApiError&&e.code==='MISSION_ROOM_NOT_READY'&&!rows(control(workspace).assignments).some(a=>['ACCEPTED','ACTIVE','BLOCKED','COMPLETED'].includes(String(a.status))))room={available:false,messages:[],reason:'MISSION_ROOM_NOT_READY'};else throw e;}
   const invitations=record(contract.contract??{}).participation_mode==='INVITE_ONLY'?await bounded(()=>client.founderMissionInvitations(mid,controller.signal)):undefined;
   const context:FounderContext={inputTrust:'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS',workspace,contract,applications,deliveries,room,...(invitations?{invitations}:{}),rejections:(s!.rejections??[]).filter(r=>r.missionId===mid&&!r.resourceKind),actions:actions(workspace).filter(a=>a.operation!=='SEND_ROOM_MESSAGE'||room.available!==false)};
   context.actions.push(...extendedFounderActions(context,candidateIds.length?candidateIds:rows(control(workspace).candidateAgents).map(a=>a.id).filter(id),o.agentId));
   if(record(control(workspace).poolReview??{}).taskOverflow===true)throw fail('FOUNDER_CONTEXT_TRUNCATED');
   if(invitations&&rows(invitations.invitations).length>=100)throw fail('FOUNDER_CONTEXT_TRUNCATED');
   if(room.hasMore===true||deliveries.deliveries.length>=100||applications.applications.length>=250)throw fail('FOUNDER_CONTEXT_TRUNCATED');
   if(new TextEncoder().encode(JSON.stringify(context)).length>1000000)throw fail('FOUNDER_CONTEXT_TOO_LARGE');return context;
  };
  let code:string|null=null,contactError=false,contactInFlight:Promise<void>|null=null;
  const interval=setInterval(()=>{if(contactInFlight)return;contactInFlight=bounded(()=>contact('ACTIVE')).catch(()=>{contactError=true;controller.abort();}).finally(()=>{contactInFlight=null;});},1800000);
  try{
   s.notBefore=now()+3300000;await save();await bounded(()=>contact('START'));
   for(const f of s.followedMissions??[])if(requestIds.includes(f.requestId))follow(f.requestId,f.missionId);
   // Receipt recovery is independent of model/provider availability.
   if(s.pending)await replay();
   // Every retained unknown outcome is resource-scoped, keeps its original key and
   // is attempted at most once per run. Quarantine never asserts non-execution.
   for(const p of s.deferred)if(!(p.resourceKind==='CREATION_REQUEST'?requestIds:missionIds).includes(p.missionId))missionIssues.push({missionId:p.missionId,code:'PENDING_MISSION_OUTSIDE_INVENTORY'});
   for(const pending of [...s.deferred].filter(p=>!p.quarantined&&p.failure?.lastRun!==runId&&(p.retryAt??0)<=now()&&(p.resourceKind==='CREATION_REQUEST'?requestIds:missionIds).includes(p.missionId)).slice(0,run.maxMissions)){
    if(attempts>=run.maxSteps)break;
    if(pending.quarantined||pending.failure?.lastRun===runId||(pending.retryAt??0)>now())continue;
    if(!(pending.resourceKind==='CREATION_REQUEST'?requestIds:missionIds).includes(pending.missionId)){missionIssues.push({missionId:pending.missionId,code:'PENDING_MISSION_OUTSIDE_INVENTORY'});continue;}
    s.pending=pending;s.deferred=s.deferred.filter(q=>q.key!==pending.key);await save();await replay();
   }
   for(const pending of s.deferred){
    if(!pending.quarantined||!pending.issue||pending.noticeRecorded)continue;
    try{await bounded(async()=>{if(o.reportIssue)await o.reportIssue(pending.issue!,controller.signal);else{const receipt=await client.reportFounderIssue(pending.issue!,controller.signal);if(receipt.founderInboxRecorded!==true||receipt.humanNotificationRecorded!==true)throw fail('FOUNDER_ALERT_UNCONFIRMED');}});pending.noticeRecorded=true;await save();}
    catch{check();missionIssues.push({missionId:pending.missionId,code:'FOUNDER_ALERT_DELIVERY_PENDING'});}
   }
   try{ready=(await bounded(()=>o.judge.ready(controller.signal)))===true;}catch(e){check();if((e as {code?:string}).code==='RUN_BUDGET_EXHAUSTED')throw e;ready=false;}
   if(!ready)throw fail('MODEL_PROVIDER_UNAVAILABLE');
   let steps=attempts;
   for(let scanned=0;scanned<Math.min(run.maxMissions,inventory.length)&&steps<run.maxSteps;scanned++){
    const position=s.cursor%inventory.length,item=inventory[position];
    try{missionId=item.kind==='MISSION'?item.id:null;
    if(s.deferred.length>=50&&!s.deferred.some(p=>sameResource(p,{missionId:item.id,...(item.kind==='CREATION_REQUEST'?{resourceKind:'CREATION_REQUEST' as const}:{})}))){missionIssues.push({missionId:item.id,code:'FOUNDER_DEFERRED_CAPACITY'});s.cursor=(position+1)%inventory.length;await save();continue;}
    const retained=s.deferred.find(p=>sameResource(p,{missionId:item.id,...(item.kind==='CREATION_REQUEST'?{resourceKind:'CREATION_REQUEST' as const}:{})}));
    if(retained){missionIssues.push({missionId:item.id,code:retained.quarantined?'UNRESOLVED_REJECTION':retained.failure?.code??'PENDING_RECEIPT_RECOVERY'});s.cursor=(position+1)%inventory.length;await save();continue;}
    const seen=new Set<string>();
    if(item.kind==='CREATION_REQUEST'){
     while(steps<run.maxSteps){
      await pulse();const snapshot=await bounded(()=>client.missionCreationRequest(item.id,controller.signal));
      const request=record(snapshot.request),founder=record(request.founderAgent);
      if(request.id!==item.id||founder.id!==o.agentId)throw fail('FOUNDER_AUTHORITY_REQUIRED');
      // Publication is deterministic after exact Human approval; no model can approve or select its target.
      if(request.status==='PUBLISHED'){if(!id(request.missionId))throw fail('FOUNDER_APPROVED_BINDING_REQUIRED');follow(item.id,request.missionId);await save();break;}
      if(request.status==='APPROVED'){
       if(!id(request.missionId)||!id(request.contractId)||typeof request.contractVersion!=='string'||!request.contractVersion||request.contractVersion.length>64||typeof request.contractHash!=='string'||!/^(sha256:)?[a-f0-9]{64}$/.test(request.contractHash))throw fail('FOUNDER_APPROVED_BINDING_REQUIRED');
       const body={mission_id:request.missionId,contract_id:request.contractId,contract_version:request.contractVersion,contract_hash:request.contractHash,creation_request_id:item.id};
       const fresh=await bounded(()=>client.missionCreationRequest(item.id,controller.signal));if(await hash(fresh)!==await hash(snapshot))throw fail('FOUNDER_CONTEXT_CHANGED');
       s.pending={resourceKind:'CREATION_REQUEST',missionId:item.id,operation:'PUBLISH_APPROVED_MISSION',body,key:'founder_'+crypto.randomUUID()};await save();await replay();steps=attempts;
       if(s.deferred.some(p=>p.missionId===item.id&&p.resourceKind==='CREATION_REQUEST'))break;
       // A successful receipt is authoritative even if a subsequent projection lags; never mint a second key this run.
       break;
      }
      // The request, exact contract and authoritative Human review note come from the service.
      const invitationActions=request.status==='CHANGES_REQUESTED'&&typeof request.reviewNote==='string'&&request.reviewNote.trim()?[]:creationInvitationActions(snapshot,candidateIds.length?candidateIds:rows(snapshot.candidateAgents).map(a=>a.id).filter(id),o.agentId,now());
      if(!['REQUESTED','DRAFTING','CHANGES_REQUESTED','STAFFING'].includes(String(request.status))&&!(request.status==='DRAFT_READY'&&invitationActions.length))break;
      const discussion=await bounded(()=>client.missionCreationMessages(item.id,controller.signal));
      if(rows(discussion.messages).length>=250)throw fail('FOUNDER_CONTEXT_TRUNCATED');
      let operation:FounderPreparationOperation=request.status==='REQUESTED'?'ACCEPT_CREATION_REQUEST':'SUBMIT_CREATION_DRAFT';
      const context:FounderPreparationContext={inputTrust:'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS',request:snapshot,discussion,rejections:(s.rejections??[]).filter(r=>r.missionId===item.id&&r.resourceKind==='CREATION_REQUEST'),actions:[...(['STAFFING','DRAFT_READY'].includes(String(request.status))||invitationActions.length?[]:[{id:operation==='ACCEPT_CREATION_REQUEST'?'accept-request':'draft',operation}]),...invitationActions]};
      if(new TextEncoder().encode(JSON.stringify(context)).length>1000000)throw fail('FOUNDER_CONTEXT_TOO_LARGE');
      if(context.actions.length===0)break;
      if(!o.judge.prepare){missionIssues.push({missionId:item.id,code:'FOUNDER_PREPARATION_ADAPTER_REQUIRED'});break;}
      const fingerprint=await basis(context),decision=record(await bounded(()=>o.judge.prepare!(structuredClone(context),controller.signal)));check();
      if(decision.wait===true){exact(decision,['wait']);break;}
      exact(decision,['actionId','body']);const action=context.actions.find(a=>a.id===decision.actionId);if(!action)throw fail('FOUNDER_ACTION_NOT_OFFERED');operation=action.operation;
      const draft=record(decision.body);let body:Record<string,unknown>;
      if(operation==='ACCEPT_CREATION_REQUEST'){exact(draft,[]);body={};}
      else if(operation==='CANCEL_CREATION_INVITATION'){exact(draft,['note']);if(!note(draft.note,2000))throw fail('INVALID_FOUNDER_DECISION');body={...action.binding,reason:draft.note};}
      else if(operation==='INVITE_CREATION_AGENT'){exact(draft,['note']);if(!note(draft.note,2000))throw fail('INVALID_FOUNDER_DECISION');body={...action.binding,invitation_note:draft.note};}
      else{exact(draft,['contract']);record(draft.contract);body={contract:draft.contract,creation_request_id:item.id};}
      if(new TextEncoder().encode(JSON.stringify(body)).length>30000)throw fail('FOUNDER_BODY_TOO_LARGE');
      const bodyHash=await hash(body),repeat=await hash({operation,body});
      if(seen.has(repeat)||(s.rejections??[]).some(r=>r.resourceKind==='CREATION_REQUEST'&&r.missionId===item.id&&r.operation===operation&&r.bodyHash===bodyHash&&r.basisHash===fingerprint)){missionIssues.push({missionId:item.id,code:'FOUNDER_NO_PROGRESS'});break;}seen.add(repeat);
      const fresh=await bounded(()=>client.missionCreationRequest(item.id,controller.signal)),freshDiscussion=await bounded(()=>client.missionCreationMessages(item.id,controller.signal));
      if(await hash({snapshot:fresh,discussion:freshDiscussion})!==await hash({snapshot,discussion}))throw fail('FOUNDER_CONTEXT_CHANGED');
      s.pending={resourceKind:'CREATION_REQUEST',basisHash:fingerprint,missionId:item.id,operation,body,key:'founder_'+crypto.randomUUID()};await save();await replay();steps=attempts;if(s.deferred.some(p=>p.key===s.pending?.key||p.missionId===item.id&&p.resourceKind===(item.kind==='CREATION_REQUEST'?'CREATION_REQUEST':undefined)))break;
     }
     s.cursor=(position+1)%inventory.length;await save();continue;
    }
    missionId=item.id;
    while(steps<run.maxSteps){
     await pulse();const context=await read(missionId);if(context.actions.length===0)break;
     const fingerprint=await basis(context),decision=record(await bounded(()=>o.judge.decide(structuredClone(context),controller.signal)));check();
     if(decision.wait===true){exact(decision,['wait']);break;}
     exact(decision,['actionId','body']);const action=context.actions.find(a=>a.id===decision.actionId);if(!action)throw fail('FOUNDER_ACTION_NOT_OFFERED');
     const body=bodyFor(action,decision.body,context);if(new TextEncoder().encode(JSON.stringify(body)).length>30000)throw fail('FOUNDER_BODY_TOO_LARGE');
     const repeat=await hash({action,body});const bodyHash=await hash(body);
     if(seen.has(repeat)||(s!.rejections??[]).some(r=>!r.resourceKind&&r.missionId===missionId&&r.operation===action.operation&&r.targetId===action.targetId&&r.bodyHash===bodyHash&&r.basisHash===fingerprint)){missionIssues.push({missionId,code:'FOUNDER_NO_PROGRESS'});break;}seen.add(repeat);
     if(await basis(await read(missionId))!==fingerprint)throw fail('FOUNDER_CONTEXT_CHANGED');
     s.pending={basisHash:fingerprint,missionId,operation:action.operation,...(action.targetId?{targetId:action.targetId}:{}),body,key:'founder_'+crypto.randomUUID()};await save();await replay();steps=attempts;if(s.deferred.some(p=>p.key===s.pending?.key||p.missionId===item.id&&p.resourceKind===undefined))break;
    }
    s.cursor=(position+1)%inventory.length;await save();
    }catch(e){
     check();const local=(e as {code?:unknown})?.code;
     const isolated=typeof local==='string'&&['INVALID_FOUNDER_DECISION','FOUNDER_ACTION_NOT_OFFERED','FOUNDER_CONTEXT_CHANGED','FOUNDER_BODY_TOO_LARGE','FOUNDER_CONTEXT_TRUNCATED','FOUNDER_CONTEXT_TOO_LARGE','FOUNDER_AUTHORITY_REQUIRED','FOUNDER_APPROVED_BINDING_REQUIRED'].includes(local);
     if(!isolated&&(!(e instanceof AgentelApiError)||![400,401,402,403,404,409,410,422].includes(e.status)))throw e;
     missionIssues.push({missionId:item.id,code:isolated?local as string:(e as AgentelApiError).code});s.cursor=(position+1)%inventory.length;await save();
    }
   }
  }catch(e){const raw=contactError?'FOUNDER_CONTACT_UNAVAILABLE':e instanceof AgentelApiError?e.code:(e as {code?:string})?.code;code=typeof raw==='string'&&/^[A-Z0-9_]{1,80}$/.test(raw)?raw:'FOUNDER_RUN_FAILED';if(e instanceof AgentelApiError&&e.retryAfterMs!==null)s.notBefore=Math.max(s.notBefore,now()+e.retryAfterMs);}
  finally{
   try{if(!controller.signal.aborted&&now()<deadline)await bounded(()=>contact('END'));}catch{code??='FOUNDER_CONTACT_UNAVAILABLE';}
   clearInterval(interval);if(contactInFlight)await contactInFlight;clearTimeout(timer);run.signal?.removeEventListener('abort',stop);s.notBefore=Math.max(s.notBefore,now()+3300000);
   const retryFloors=inventory.map(item=>s!.deferred?.find(p=>sameResource(p,{missionId:item.id,...(item.kind==='CREATION_REQUEST'?{resourceKind:'CREATION_REQUEST' as const}:{})}))?.retryAt??0);
   if(retryFloors.length&&retryFloors.every(t=>t>now()))s.notBefore=Math.max(s.notBefore,Math.min(...retryFloors));await save();
  }
  const allDeferred=inventory.length>0&&inventory.every(item=>s!.deferred!.some(p=>sameResource(p,{missionId:item.id,...(item.kind==='CREATION_REQUEST'?{resourceKind:'CREATION_REQUEST' as const}:{})})));
  const jitter=Math.max(0,Math.min(1,(o.random??Math.random)()));return {status:code||allDeferred?'BLOCKED':completed||rejected?'PROGRESSED':missionIssues.length?'BLOCKED':'IDLE',completed,rejected,missionIssues,code:code??(missionIssues.length?missionIssues[0].code:null),nextCheckAt:Math.max(s.notBefore,now()+3600000+(jitter*2-1)*300000)};
 })??{status:'BUSY',completed:0,rejected:0,missionIssues:[],code:'LOCAL_WORKER_LEASE_BUSY',nextCheckAt:null};
}
