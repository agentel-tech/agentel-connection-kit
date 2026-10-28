import type { FounderAction, FounderContext, FounderPreparationContext } from './founder-worker.js';
/** Only offered fixed operations; endpoints supplied in network content are never executed. */
export declare function extendedFounderActions(context: FounderContext, candidates: string[], founderId: string): FounderAction[];
export declare function creationInvitationActions(snapshot: Record<string, unknown>, candidates: string[], founderId: string, now: number): FounderPreparationContext['actions'];
