const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const rows = (v) => Array.isArray(v) ? v.map(obj) : [];
const valid = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const live = new Set(['RESERVED', 'ACCEPTED', 'ACTIVE', 'BLOCKED']);
/** Only offered fixed operations; endpoints supplied in network content are never executed. */
export function extendedFounderActions(context, candidates, founderId) {
    const w = context.workspace, c = obj(w.founderControl), raw = obj(context.contract.contract), out = [];
    if (['CANCELLED', 'COMPLETED', 'FAILED'].includes(w.mission.status) || ['RESULT_PUBLISHED', 'OUTCOME_ACCEPTED'].includes(w.state) || obj(c.outcomeNextAction).action === 'WAIT_FOR_HUMAN_FINAL_DECISION')
        return out;
    for (const a of rows(c.assignments))
        if (valid(a.id))
            for (const n of rows(a.nextActions)) {
                const b = obj(n.body);
                if (n.type === 'REVIEW_REPLACEMENT' && valid(b.application_id) && rows(a.replacementCandidates).some(x => x.applicationId === b.application_id))
                    out.push({ id: 'replace:' + a.id + ':' + b.application_id, operation: 'REPLACE_ASSIGNMENT', targetId: a.id, binding: b });
            }
    for (const t of rows(obj(c.poolReview).tasks))
        if (valid(t.id) && t.canRetry === true && Number.isInteger(t.revision) && typeof t.digest === 'string')
            out.push({ id: 'retry:' + t.id, operation: 'RETRY_REVIEW', targetId: t.id, binding: { expected_revision: t.revision, expected_digest: t.digest } });
    if (context.deliveries.internalCheck && context.deliveries.reviewMode === 'INTERNAL_CHECK') {
        const latest = new Set();
        for (const d of rows(context.deliveries.deliveries)) {
            if (!valid(d.id) || !valid(d.assignmentId) || latest.has(d.assignmentId))
                continue;
            latest.add(d.assignmentId);
            if (d.status === 'SUBMITTED' && d.agentId !== founderId && d.contractHash === w.mission.contractHash && d.contractVersion === w.mission.contractVersion)
                out.push({ id: 'check:' + d.id, operation: 'INTERNAL_CHECK', targetId: d.id });
        }
    }
    if (raw.visibility === 'PUBLIC' && raw.participation_mode === 'INVITE_ONLY' && candidates.length) {
        const invitations = rows(context.invitations?.invitations), assignments = rows(c.assignments);
        for (const stage of rows(raw.stages))
            for (const slot of rows(stage.role_slots)) {
                if (!valid(stage.stage_id) || !valid(slot.slot_id) || !Number.isInteger(slot.quantity) || Number(slot.quantity) < 1 || Number(slot.quantity) > 10)
                    continue;
                if (obj(raw.review_policy).protocol === 'POOL_REVIEW_V1' && stage.stage_kind === 'REVIEW' && obj(raw.review_policy).mode !== 'INTERNAL_CHECK')
                    continue;
                for (let seat = 1; seat <= Number(slot.quantity); seat++) {
                    if (invitations.some(i => i.stageId === stage.stage_id && i.slotId === slot.slot_id && i.slotIndex === seat && ['OFFERED', 'WAITING'].includes(String(i.status))))
                        continue;
                    const current = assignments.find(a => a.stageId === stage.stage_id && a.slotId === slot.slot_id && a.slotIndex === seat && live.has(String(a.status)));
                    if (current && !['ACK_OVERDUE', 'DELIVERY_OVERDUE', 'REPLACEMENT_REVIEW_REQUIRED'].includes(String(obj(current.sla).state)))
                        continue;
                    out.push({ id: 'invite:' + stage.stage_id + ':' + slot.slot_id + ':' + seat, operation: 'INVITE_CANDIDATES', binding: { stage_id: stage.stage_id, slot_id: slot.slot_id, slot_index: seat, contract_hash: w.mission.contractHash, contract_version: w.mission.contractVersion, ...(current ? { replace_assignment_id: current.id } : {}), candidateAgentIds: candidates.filter(id => id !== founderId) } });
                }
            }
    }
    return out;
}
export function creationInvitationActions(snapshot, candidates, founderId, now) {
    const raw = obj(snapshot.contract), request = obj(snapshot.request), participants = rows(snapshot.participants), out = [];
    if (raw.visibility !== 'PRIVATE' || !request.missionId)
        return out;
    for (const p of participants)
        if (valid(p.id) && ['INVITED', 'ACCEPTED'].includes(String(p.status))) {
            const due = typeof p.responseDueAt === 'string' ? Date.parse(p.responseDueAt) : Date.parse(String(p.invitedAt)) + Math.max(2, Number(obj(raw.sla_policy).ack_hours) || 2) * 3600000;
            if (p.checkerOwnerValid === false || p.status === 'INVITED' && Number.isFinite(due) && due <= now)
                out.push({ id: 'cancel-invite:' + p.id, operation: 'CANCEL_CREATION_INVITATION', binding: { participant_id: p.id } });
        }
    for (const stage of rows(raw.stages))
        for (const slot of rows(stage.role_slots)) {
            if (!valid(stage.stage_id) || !valid(slot.slot_id) || !Number.isInteger(slot.quantity) || Number(slot.quantity) < 1 || Number(slot.quantity) > 10)
                continue;
            if (obj(raw.review_policy).protocol === 'POOL_REVIEW_V1' && stage.stage_kind === 'REVIEW' && obj(raw.review_policy).mode !== 'INTERNAL_CHECK')
                continue;
            const occupied = participants.filter(p => p.stageId === stage.stage_id && p.slotId === slot.slot_id && ['INVITED', 'ACCEPTED', 'ASSIGNED'].includes(String(p.status)));
            if (occupied.length >= Number(slot.quantity))
                continue;
            for (const candidate of candidates)
                if (candidate !== founderId && !participants.some(p => p.stageId === stage.stage_id && p.slotId === slot.slot_id && obj(p.agent).id === candidate))
                    out.push({ id: 'invite:' + stage.stage_id + ':' + slot.slot_id + ':' + candidate, operation: 'INVITE_CREATION_AGENT', binding: { stage_id: stage.stage_id, slot_id: slot.slot_id, agent_id: candidate } });
        }
    return out;
}
