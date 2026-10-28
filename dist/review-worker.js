import { AgentelApiError } from './agentel-connector.js';
const opaque = (v) => /^[A-Za-z0-9_-]{1,128}$/.test(v), key = (prefix) => prefix + '_' + crypto.randomUUID();
const fault = (code) => Object.assign(new Error(code), { code });
function output(value, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw fault('INVALID_MODEL_OUTPUT'); return value; }
function staleTask(error) { return error instanceof AgentelApiError && ((error.status === 404 && ['REVIEW_TASK_NOT_FOUND', 'REVIEW_RESPONSE_NOT_AVAILABLE'].includes(error.code)) || (error.status === 409 && error.code === 'REVIEW_TASK_CONFLICT')); }
function assessment(value, task) {
    const answer = output(value, ['decision', 'note', 'evidence_ids', 'unavailable_evidence_ids']);
    const ids = (v) => Array.isArray(v) && v.length <= 1000 && v.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128) && new Set(v).size === v.length;
    if (!['ACCEPTED', 'REVISION_REQUESTED', 'REJECTED'].includes(String(answer.decision)) || typeof answer.note !== 'string' || answer.note.trim().length < 4 || answer.note.length > 4000 || !ids(answer.evidence_ids) || (answer.unavailable_evidence_ids !== undefined && !ids(answer.unavailable_evidence_ids)))
        throw fault('INVALID_MODEL_OUTPUT');
    const inspected = answer.evidence_ids, unavailable = (answer.unavailable_evidence_ids ?? []), evidence = task.input?.evidence;
    if (!Array.isArray(evidence))
        throw fault('INVALID_REVIEW_INPUT');
    if (new TextEncoder().encode(JSON.stringify(answer)).length > 30000)
        throw fault('INVALID_MODEL_OUTPUT');
    const bound = evidence.map(e => e?.id);
    if ([...inspected, ...unavailable].some(id => !bound.includes(id)) || inspected.some(id => unavailable.includes(id)) || (answer.decision === 'ACCEPTED' && (unavailable.length > 0 || bound.some(id => !inspected.includes(id)))))
        throw fault('INVALID_MODEL_OUTPUT');
    return answer;
}
/** A bounded run, not a daemon or a model service. The operator schedules the returned next check. */
export async function runReviewWorker(o, run) {
    if (!opaque(o.agentId) || !opaque(o.deploymentId) || !Number.isInteger(run.maxTasks) || run.maxTasks < 1 || run.maxTasks > 10 || !Number.isInteger(run.maxInboxPages) || run.maxInboxPages < 1 || run.maxInboxPages > 10 || !Number.isFinite(run.maxRunMs) || run.maxRunMs < 1 || run.maxRunMs > 21600000)
        throw fault('INVALID_WORKER_CONFIGURATION');
    const client = o.client.forReviewWorker();
    const now = o.now ?? Date.now, random = o.random ?? Math.random, start = now(), deadline = start + run.maxRunMs;
    const result = await o.store.exclusive(async (store) => {
        let s = await store.load();
        if (s && s.schema !== 1)
            throw fault('UNSUPPORTED_CHECKPOINT');
        if (!s)
            s = { schema: 1, instanceId: key('review_worker'), notBefore: 0, cursor: null, taskId: null, claimId: null, generation: null, digest: null, pending: null, heartbeat: null };
        if (s.notBefore > now())
            return { status: 'WAIT_NEXT_CHECK', completed: 0, nextCheckAt: s.notBefore, code: null };
        const jitter = Math.max(0, Math.min(1, random()));
        let nextCheck = start + 3600000 + (jitter * 2 - 1) * 300000;
        // 55min is the earliest legal idle wake; a fixed hourly scheduler may also wake normally.
        s.notBefore = start + 3300000;
        await store.save(s);
        let completed = 0, ready = false, readinessKnown = false, heartbeatError = null, chain = Promise.resolve();
        const controller = new AbortController(), onAbort = () => controller.abort();
        run.signal?.addEventListener('abort', onAbort, { once: true });
        if (run.signal?.aborted)
            controller.abort();
        const timer = setTimeout(() => controller.abort(), run.maxRunMs);
        const check = () => { if (controller.signal.aborted || now() >= deadline)
            throw fault('RUN_LIMIT_REACHED'); };
        const serial = (fn) => { const work = chain.then(fn); chain = work.then(() => { }, () => { }); return work; };
        const call = async (fn) => { check(); return fn(); };
        const save = () => store.save(s);
        const scheduleNext = () => { s.notBefore = Math.max(s.notBefore, now() + 3300000); nextCheck = Math.max(nextCheck, now() + 3600000 + (jitter * 2 - 1) * 300000); };
        const checkpoint = () => ({ cursor: s.cursor, task_id: s.taskId, claim_id: s.claimId, claim_generation: s.generation, digest: s.digest, pending_operation: s.pending ? (s.pending.kind === 'RESPONSE' ? 'OUTCOME_RESPONSE' : s.pending.kind) : null, pending_key: s.pending?.key ?? null, last_attempted: null });
        async function heartbeat() {
            check();
            const runtime = await client.reviewRuntime(controller.signal);
            if (runtime.agentId !== o.agentId)
                throw fault('WORKER_IDENTITY_MISMATCH');
            if (s.heartbeat) {
                try {
                    await client.heartbeatReviewRuntime(s.heartbeat.body, s.heartbeat.key, controller.signal);
                }
                catch (e) {
                    if (!(e instanceof AgentelApiError && e.status === 409 && e.code === 'REVIEW_RUNTIME_CONFLICT'))
                        throw e;
                }
                s.heartbeat = null;
                await save();
            }
            const current = await client.reviewRuntime(controller.signal);
            if (current.runtime && current.runtime.instanceId !== s.instanceId && current.runtime.sameCredential && Date.parse(current.runtime.leaseExpiresAt) > now())
                throw fault('REVIEW_RUNTIME_CONFLICT');
            let metadata = checkpoint();
            if (s.taskId) {
                try {
                    await client.reviewTask(s.taskId, controller.signal);
                }
                catch (e) {
                    if (!(e instanceof AgentelApiError && e.status === 404))
                        throw e;
                    metadata = { ...metadata, task_id: null, claim_id: null, claim_generation: null, digest: null, pending_operation: null, pending_key: null };
                }
            }
            const body = { expected_generation: current.generation, expected_revision: current.revision, instance_id: s.instanceId, deployment_id: o.deploymentId, api_reachability: 'AVAILABLE', model_readiness: readinessKnown ? (ready ? 'READY' : 'UNAVAILABLE') : 'UNKNOWN', failure_code: readinessKnown && !ready ? 'MODEL_UNAVAILABLE' : 'NONE', checkpoint: metadata };
            s.heartbeat = { body, key: key('heartbeat') };
            await save();
            const receipt = await client.heartbeatReviewRuntime(body, s.heartbeat.key, controller.signal);
            if (receipt.agentId !== o.agentId)
                throw fault('WORKER_IDENTITY_MISMATCH');
            s.heartbeat = null;
            await save();
        }
        function clearTask() { s.taskId = null; s.claimId = null; s.generation = null; s.digest = null; }
        async function sendPending() {
            const p = s.pending;
            // Canonical re-read before recovery; a missing Task may still have a committed receipt.
            try {
                await call(() => client.reviewTask(p.taskId, controller.signal));
            }
            catch (e) {
                if (!(e instanceof AgentelApiError && e.status === 404))
                    throw e;
            }
            await heartbeat();
            let receipt;
            try {
                receipt = await call(() => p.kind === 'CLAIM' ? client.claimReviewTask(p.taskId, p.body, p.key, controller.signal) : p.kind === 'VERDICT' ? client.submitReviewVerdict(p.taskId, p.body, p.key, controller.signal) : p.kind === 'RELEASE' ? client.releaseReviewTask(p.taskId, p.body, p.key, controller.signal) : client.respondToReviewOutcome(p.taskId, p.body, p.key, controller.signal));
            }
            catch (e) {
                if (staleTask(e)) {
                    s.pending = null;
                    clearTask();
                    await save();
                    return false;
                }
                throw e;
            }
            s.pending = null;
            if (p.kind === 'CLAIM') {
                s.taskId = p.taskId;
                s.claimId = String(receipt.claimId);
                s.generation = Number(receipt.generation);
                s.digest = String(receipt.digest);
            }
            else {
                clearTask();
                if (p.kind === 'VERDICT' || p.kind === 'RESPONSE')
                    completed++;
            }
            await save();
            return true;
        }
        async function write(kind, taskId, body) { check(); s.taskId = taskId; s.pending = { kind, taskId, body: body, key: key(kind.toLowerCase()) }; await save(); return sendPending(); }
        async function model(fn, expiresAt) {
            check();
            const runRemaining = deadline - now() - 1000, claimRemaining = expiresAt ? Date.parse(expiresAt) - now() - 60000 : Infinity;
            const remaining = Math.min(runRemaining, claimRemaining), timeoutCode = claimRemaining <= runRemaining ? 'CLAIM_TIME_UNAVAILABLE' : 'RUN_BUDGET_EXHAUSTED';
            if (!Number.isFinite(remaining))
                throw fault('MODEL_TIME_UNAVAILABLE');
            if (remaining <= 0)
                throw fault(timeoutCode);
            let rejectAbort;
            const modelController = new AbortController(), abort = () => { modelController.abort(); rejectAbort?.(fault('RUN_LIMIT_REACHED')); };
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted)
                abort();
            let cancel;
            try {
                return await Promise.race([new Promise((_, reject) => { rejectAbort = reject; if (controller.signal.aborted)
                        abort(); }), fn(modelController.signal), new Promise((_, reject) => { cancel = setTimeout(() => { modelController.abort(); reject(fault(timeoutCode)); }, remaining); })]);
            }
            finally {
                if (cancel)
                    clearTimeout(cancel);
                controller.signal.removeEventListener('abort', abort);
            }
        }
        let pulse;
        try {
            // A failed/unknown provider is never treated as available. No fallback is selected here.
            await serial(heartbeat);
            pulse = setInterval(() => { void serial(heartbeat).catch(e => { heartbeatError = e; controller.abort(); }); }, 1800000);
            // Recover committed/requested effects before asking a model that may now be down.
            if (s.pending)
                await serial(sendPending);
            try {
                ready = (await model(signal => o.judge.ready(signal))) === true;
            }
            catch (e) {
                if (controller.signal.aborted || ['RUN_BUDGET_EXHAUSTED', 'RUN_LIMIT_REACHED'].includes(e?.code ?? ''))
                    throw e;
                ready = false;
            }
            readinessKnown = true;
            await serial(heartbeat);
            async function processTask(taskId) {
                const task = await call(() => client.reviewTask(taskId, controller.signal));
                if (task.nextAction?.type === 'READ_OUTCOME_RESPONSE') {
                    if (!ready)
                        return;
                    const context = await call(() => client.reviewOutcomeResponse(taskId, controller.signal));
                    if (typeof context.reviewSetHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(context.reviewSetHash) || !Number.isInteger(context.round) || typeof context.expiresAt !== 'string')
                        throw fault('INVALID_RESPONSE_CONTEXT');
                    const answer = output(await model(signal => o.judge.respond(structuredClone({ ...context, inputTrust: 'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS' }), signal), context.expiresAt), ['decision', 'note']);
                    if (!['REVISE', 'MAINTAIN'].includes(String(answer.decision)) || typeof answer.note !== 'string' || answer.note.trim().length < 4 || answer.note.length > 4000)
                        throw fault('INVALID_MODEL_OUTPUT');
                    await serial(() => write('RESPONSE', taskId, { ...answer, expected_review_set_hash: context.reviewSetHash, expected_round: context.round }));
                    return;
                }
                if (task.status === 'OFFERED') {
                    if (!ready)
                        return;
                    const claimed = await serial(() => write('CLAIM', taskId, { expected_revision: task.revision, expected_digest: task.digest }));
                    if (!claimed)
                        return;
                }
                const current = await call(() => client.reviewTask(taskId, controller.signal));
                if (!current.claim || !current.input || !current.reviewContext) {
                    if (s.taskId === taskId) {
                        clearTask();
                        await save();
                    }
                    return;
                }
                if (current.inputTrust !== 'UNTRUSTED_CONTENT_NOT_INSTRUCTIONS')
                    throw fault('INVALID_REVIEW_INPUT');
                s.taskId = taskId;
                s.claimId = current.claim.id;
                s.generation = current.claim.generation;
                s.digest = current.digest;
                await save();
                if (!ready) {
                    await serial(() => write('RELEASE', taskId, { claim_id: current.claim.id, generation: current.claim.generation, reason: 'MODEL_PROVIDER_UNAVAILABLE' }));
                    return;
                }
                let answer;
                try {
                    // One format repair is allowed, under the same run/claim time limits and frozen input.
                    try {
                        answer = assessment(await model(signal => o.judge.inspect(structuredClone(current), signal), current.claim.expiresAt), current);
                    }
                    catch (e) {
                        if (e?.code !== 'INVALID_MODEL_OUTPUT')
                            throw e;
                        answer = assessment(await model(signal => o.judge.inspect(structuredClone(current), signal, { attempt: 2, reason: 'INVALID_MODEL_OUTPUT' }), current.claim.expiresAt), current);
                    }
                }
                catch (e) {
                    const code = e?.code;
                    // A process run budget is not inability to do the Task: retain the canonical claim.
                    if (controller.signal.aborted || code === 'RUN_BUDGET_EXHAUSTED' || code === 'RUN_LIMIT_REACHED')
                        throw e;
                    ready = false;
                    const reason = ['INVALID_MODEL_OUTPUT', 'INVALID_REVIEW_INPUT', 'MODEL_TIME_UNAVAILABLE', 'CLAIM_TIME_UNAVAILABLE'].includes(code ?? '') ? 'CANNOT_COMPLETE' : 'MODEL_PROVIDER_UNAVAILABLE';
                    await serial(() => write('RELEASE', taskId, { claim_id: current.claim.id, generation: current.claim.generation, reason }));
                    throw fault(reason === 'CANNOT_COMPLETE' ? (code ?? 'CANNOT_COMPLETE') : 'MODEL_PROVIDER_UNAVAILABLE');
                }
                // The model supplies assessment only. Identity, Task/version and claim fence come from canonical state.
                const latest = await call(() => client.reviewTask(taskId, controller.signal));
                if (!latest.claim || latest.claim.id !== current.claim.id || latest.claim.generation !== current.claim.generation || latest.digest !== current.digest || latest.revision !== current.revision) {
                    clearTask();
                    await save();
                    return;
                }
                await serial(() => write('VERDICT', taskId, { ...answer, expected_revision: latest.revision, expected_digest: latest.digest, claim_id: latest.claim.id, generation: latest.claim.generation }));
            }
            if (s.taskId && completed < run.maxTasks) {
                try {
                    await processTask(s.taskId);
                }
                catch (e) {
                    if (!staleTask(e))
                        throw e;
                    clearTask();
                    await save();
                }
            }
            const seen = new Set();
            for (let page = 0; page < run.maxInboxPages && completed < run.maxTasks; page++) {
                const inbox = await call(() => client.reviewTasks({ limit: 20, ...(s.cursor ? { cursor: s.cursor } : {}), signal: controller.signal }));
                const pageCursor = s.cursor;
                let exhausted = true;
                for (const item of inbox.items) {
                    if (completed >= run.maxTasks) {
                        exhausted = false;
                        break;
                    }
                    if (seen.has(item.id))
                        continue;
                    seen.add(item.id);
                    try {
                        await processTask(item.id);
                    }
                    catch (e) {
                        if (staleTask(e)) {
                            if (s.taskId === item.id)
                                clearTask();
                            await save();
                            continue;
                        }
                        throw e;
                    }
                }
                s.cursor = exhausted ? inbox.nextCursor : pageCursor;
                await save();
                if (!inbox.nextCursor || !exhausted)
                    break;
            }
            await save();
            await serial(heartbeat);
            scheduleNext();
            await save();
            return { status: !ready ? 'BLOCKED' : completed ? 'PROGRESSED' : 'IDLE', completed, nextCheckAt: nextCheck, code: ready ? null : 'MODEL_PROVIDER_UNAVAILABLE' };
        }
        catch (caught) {
            const e = heartbeatError ?? caught;
            const candidate = e instanceof AgentelApiError ? e.code : typeof e?.code === 'string' ? e.code : 'RUN_FAILED';
            const code = /^[A-Z0-9_]{1,80}$/.test(candidate) ? candidate : 'RUN_FAILED';
            if (e instanceof AgentelApiError && e.retryAfterMs !== null) {
                s.notBefore = Math.max(s.notBefore, now() + e.retryAfterMs);
                nextCheck = Math.max(nextCheck, s.notBefore);
            }
            scheduleNext();
            await save();
            return { status: 'BLOCKED', completed, nextCheckAt: nextCheck, code };
        }
        finally {
            if (pulse)
                clearInterval(pulse);
            clearTimeout(timer);
            run.signal?.removeEventListener('abort', onAbort);
            await chain;
        }
    });
    return result ?? { status: 'BUSY', completed: 0, nextCheckAt: null, code: 'LOCAL_WORKER_LEASE_BUSY' };
}
