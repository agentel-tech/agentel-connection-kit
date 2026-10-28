import { type AgentelConnector, type AgentelReviewRuntimeHeartbeat, type AgentelReviewTask, type AgentelReviewVerdict, type AgentelReviewOutcomeResponse } from './agentel-connector.js';
type Pending = {
    kind: 'CLAIM' | 'VERDICT' | 'RELEASE' | 'RESPONSE';
    taskId: string;
    key: string;
    body: Record<string, unknown>;
};
export type ReviewWorkerState = {
    schema: 1;
    instanceId: string;
    notBefore: number;
    cursor: string | null;
    taskId: string | null;
    claimId: string | null;
    generation: number | null;
    digest: string | null;
    pending: Pending | null;
    heartbeat: {
        body: AgentelReviewRuntimeHeartbeat;
        key: string;
    } | null;
};
export type ReviewWorkerSession = {
    load(): Promise<ReviewWorkerState | null>;
    save(state: ReviewWorkerState): Promise<void>;
};
/** Must be durable, encrypted and exclusive across cooperating replicas. No in-memory production fallback. */
export type ReviewWorkerStore = {
    exclusive<T>(work: (session: ReviewWorkerSession) => Promise<T>): Promise<T | null>;
};
export type ReviewWorkerJudge = {
    ready(signal: AbortSignal): Promise<boolean>;
    inspect(task: Readonly<AgentelReviewTask>, signal: AbortSignal, repair?: {
        attempt: 2;
        reason: 'INVALID_MODEL_OUTPUT';
    }): Promise<Pick<AgentelReviewVerdict, 'decision' | 'note' | 'evidence_ids' | 'unavailable_evidence_ids'>>;
    respond(context: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Pick<AgentelReviewOutcomeResponse, 'decision' | 'note'>>;
};
export type ReviewWorkerOptions = {
    agentId: string;
    deploymentId: string;
    client: AgentelConnector;
    store: ReviewWorkerStore;
    judge: ReviewWorkerJudge;
    now?: () => number;
    random?: () => number;
};
export type ReviewWorkerRun = {
    maxTasks: number;
    maxInboxPages: number;
    maxRunMs: number;
    signal?: AbortSignal;
};
export type ReviewWorkerResult = {
    status: 'IDLE' | 'PROGRESSED' | 'BLOCKED' | 'WAIT_NEXT_CHECK' | 'BUSY';
    completed: number;
    nextCheckAt: number | null;
    code: string | null;
};
/** A bounded run, not a daemon or a model service. The operator schedules the returned next check. */
export declare function runReviewWorker(o: ReviewWorkerOptions, run: ReviewWorkerRun): Promise<ReviewWorkerResult>;
export {};
