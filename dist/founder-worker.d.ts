import { type AgentelConnector, type AgentelMissionWorkspace } from './agentel-connector.js';
export type FounderPreparationOperation = 'ACCEPT_CREATION_REQUEST' | 'SUBMIT_CREATION_DRAFT' | 'PUBLISH_APPROVED_MISSION' | 'INVITE_CREATION_AGENT' | 'CANCEL_CREATION_INVITATION';
export type FounderPreparationContext = {
    inputTrust: 'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS';
    request: Record<string, unknown>;
    discussion: Record<string, unknown>;
    rejections: FounderRejection[];
    actions: Array<{
        id: string;
        operation: FounderPreparationOperation;
        binding?: Record<string, unknown>;
    }>;
};
export type FounderOperation = 'SELECT_APPLICATIONS' | 'ACTIVATE_ASSIGNMENT' | 'SEND_ROOM_MESSAGE' | 'OUTCOME_OPINION' | 'FINAL_CANDIDATE' | 'INVITE_CANDIDATES' | 'REPLACE_ASSIGNMENT' | 'RETRY_REVIEW' | 'INTERNAL_CHECK';
export type FounderAction = {
    id: string;
    operation: FounderOperation;
    targetId?: string;
    binding?: Record<string, unknown>;
};
export type FounderContext = {
    inputTrust: 'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS';
    workspace: AgentelMissionWorkspace;
    contract: Record<string, unknown>;
    applications: Record<string, unknown>;
    deliveries: Record<string, unknown>;
    room: Record<string, unknown>;
    actions: FounderAction[];
    invitations?: Record<string, unknown>;
    rejections?: FounderRejection[];
};
export type FounderRejection = {
    missionId: string;
    operation: FounderOperation | FounderPreparationOperation;
    resourceKind?: 'CREATION_REQUEST';
    targetId?: string;
    issues?: Array<{
        path: string;
        code: string;
        suggestedValue?: number;
    }>;
    key: string;
    bodyHash: string;
    basisHash: string | null;
    code: string;
    status: number;
    rejectedAt: string;
};
export type FounderIssue = {
    id: string;
    resourceId: string;
    resourceKind: 'MISSION' | 'CREATION_REQUEST';
    code: string;
    status: number;
    operationKeyHash: string;
};
type Pending = {
    failure?: {
        code: string;
        status: number;
        runs: number;
        lastRun: string;
    };
    quarantined?: boolean;
    quarantineReason?: 'UNRESOLVED_REJECTION';
    issue?: FounderIssue;
    noticeRecorded?: boolean;
    retryAt?: number;
    basisHash?: string;
    resourceKind?: 'CREATION_REQUEST';
    missionId: string;
    operation: FounderOperation | FounderPreparationOperation;
    targetId?: string;
    body: Record<string, unknown>;
    key: string;
};
export type FounderWorkerState = {
    schema: 1;
    role: 'FOUNDER';
    agentId: string;
    notBefore: number;
    cursor: number;
    pending: Pending | null;
    rejections?: FounderRejection[];
    deferred?: Pending[];
    followedMissions?: Array<{
        requestId: string;
        missionId: string;
    }>;
};
export type FounderWorkerSession = {
    load(): Promise<FounderWorkerState | null>;
    save(state: FounderWorkerState): Promise<void>;
};
export type FounderWorkerStore = {
    exclusive<T>(work: (session: FounderWorkerSession) => Promise<T>): Promise<T | null>;
};
export type FounderDecision = {
    actionId: string;
    body: Record<string, unknown>;
} | {
    wait: true;
};
export type FounderWorkerOptions = {
    agentId: string;
    client: AgentelConnector;
    store: FounderWorkerStore;
    judge: {
        ready(signal: AbortSignal): Promise<boolean>;
        decide(context: Readonly<FounderContext>, signal: AbortSignal): Promise<FounderDecision>;
        prepare?(context: Readonly<FounderPreparationContext>, signal: AbortSignal): Promise<FounderDecision>;
    };
    /** Operator role-specific liveness port, not the reviewer-only heartbeat route. No business authority. */
    contact(metadata: {
        role: 'FOUNDER';
        state: 'START' | 'ACTIVE' | 'END';
        missionId: string | null;
    }, signal: AbortSignal): Promise<void>;
    /** Ordinary authenticated notification API by default; injected ports must durably alert both audiences. */
    reportIssue?(issue: FounderIssue, signal: AbortSignal): Promise<void>;
    now?: () => number;
    random?: () => number;
};
export type FounderWorkerRun = {
    missionIds: string[];
    creationRequestIds?: string[];
    candidateAgentIds?: string[];
    maxMissions: number;
    maxSteps: number;
    maxRunMs: number;
    signal?: AbortSignal;
};
/** Operator supplies the explicit owned Mission inventory. No arbitrary model tools or Human decisions. */
export declare function runFounderWorker(o: FounderWorkerOptions, run: FounderWorkerRun): Promise<{
    status: string;
    completed: number;
    rejected: number;
    missionIssues: {
        missionId: string;
        code: string;
    }[];
    code: string | null;
    nextCheckAt: number;
} | {
    status: string;
    completed: number;
    rejected: number;
    missionIssues: never[];
    code: string;
    nextCheckAt: null;
}>;
export {};
