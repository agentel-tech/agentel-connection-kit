# Bounded pool reviewer adapter v1

This is executable operator-side code, not a deployed scheduler, hosted model service or proof that Official/Panda/Evidence are active. API/SDK release, real identity/credential binding, actual execution/model tools and separately authorized rehearsal are still required. Installing this SDK does not register a new Agent, join the pool, activate credentials or grant Human authority. SDK 2.1.0 carries this adapter. Consult the npm receipt for publication status; no runtime is activated by installation.

## Components

- `@agentel/sdk/review-worker`: portable `runReviewWorker(options, limits)` and typed judgment/storage ports. It consumes only own reviewer runtime/inbox/Task/claim/release/verdict/outcome-response routes through the normal SDK.
- `@agentel/sdk/node-review-store`: `node:sqlite` operator implementation (tested Node26.4.0) of the storage port. Verify that the operator runtime exposes `node:sqlite`; some Node versions label it experimental. A dedicated0700directory contains0600lock/checkpoint SQLite files. AES-256-GCM binds ciphertext to Agent ID + non-secret credential binding ID. Its32-byte key must come from an operator-approved secret broker; it is not saved in those files or sent to the model. Private pending request bodies are encrypted; no plaintext production fallback exists.
- `AgentelConnector.forReviewWorker()` creates an isolated no-auto-retry transport. General SDK retry behavior is unchanged. `AgentelApiError.retryAfterMs` preserves a server Retry-After duration/date for the worker; a429never triggers a hidden4-second retry.

Use one Agent/reviewer credential binding per dedicated store directory. Do not repurpose the directory for another Agent/key or lose its encryption key: authentication failure stops recovery rather than silently resetting state. Approved retention/key rotation/erasure of these new operator-held private request bodies is an activation prerequisite; this code grants no retention period or data-destination permission.

## Operator wiring (explicit ports, not invented provider APIs)

Construct an ordinary `AgentelConnector` with a broker-injected dedicated MISSION_POOL_REVIEW/RESTRICTED key, and a storage port. Then supply:

```ts
import {runReviewWorker, type ReviewWorkerJudge} from '@agentel/sdk/review-worker';
import {NodeReviewWorkerStore} from '@agentel/sdk/node-review-store';

// client, directory, encryptionKey, agentId, credentialBindingId, deploymentId
// come from your reviewed operator configuration/secret broker.
const store = new NodeReviewWorkerStore({directory, encryptionKey, agentId, credentialBindingId});
const judge: ReviewWorkerJudge = {
  async ready(signal) { /* report genuine approved model/tool readiness */ },
  async inspect(task, signal, repair) { /* inspect the bound version; return decision/note/inspected/unavailable IDs */ },
  async respond(context, signal) { /* evaluate the exact disagreement; return REVISE or MAINTAIN + note */ },
};
const result = await runReviewWorker(
  {agentId, deploymentId, client, store, judge},
  {maxTasks:1, maxInboxPages:2, maxRunMs:900000},
);
// These example per-run limits are operator choices, not new platform/spend policy.
// Schedule the next supported invocation at result.nextCheckAt; no scheduler is created here.
```

The callback comments are intentionally implementation ports, not a working model-provider example. `ready` returns boolean; `inspect`/`respond` must return the declared assessment shapes. The approved runtime must implement the callbacks, bounded model/tool work and cancellation. It must use approved data destinations and operator-controlled model routing. Do not claim real reasoning from test fixtures, an idle poll or a heartbeat.

Panda Ops/Evidence keep their current cloud runtimes/models and implement those ports. Official must use the Human-selected subscription Work/Codex environment and advanced judgment policy; no OpenAI API inference key, separately billed provider, paid-overage switch or silent cheaper-model fallback is added here. A chat cannot directly use a laptop directory while the laptop is asleep. Official needs a reviewed cloud execution/tool bridge and durable exclusive encrypted backend implementing the same port. The Node store is an option for operator runtimes, not evidence that such a Work bridge is configured or supported on this account.

## Execution, recovery and authority

A scheduled invocation runs immediate actions continuously: own inbox→read→claim→re-read exact private input/rubric→judge→re-read current fence→submit. Outcome replies use the separate version/round-bound response grant, never reopen the old work claim. The model receives cloned untrusted-content context and returns assessment only; it cannot choose identity, credential, Task fence, endpoints, budget or Human decision. The adapter checks assessment shape/bound evidence; it never invents inspected IDs. Actual inspection honesty remains the approved judgment adapter's responsibility, beyond the server's declaration checks.

The operator supplies finite task/page/time limits. At most10Tasks and10inbox pages per run are allowed by this implementation; these are execution bounds, not Mission quotas. `maxRunMs` is required and capped at6hours. Reasoning gets a cancellation signal. A run-budget cutoff preserves the existing claim/checkpoint for a later run; only a binding claim-work deadline uses the release margin. Late results are ignored after cancellation. The operator must also cancel external model/tool work; JavaScript cannot retract an external action from an adapter that ignores its signal.

Before a business write, the exact body + one generated stable key is committed to encrypted storage. A response lost after commit leaves that pending request; recovery reads canonical state and resends the identical body/key to recover the original receipt. Claim/verdict/release/response writes never auto-retry or generate a replacement key for an unknown outcome. A changed/superseded Task cannot inherit the previous judgment; a later run discovers the new current Task. `completed` counts settled verdict/response operations, including recovered receipts; it is not Mission completion, current proof validity, Human acceptance or publication.

A dedicated SQLite process-lease database serializes cooperating processes while a separate checkpoint database commits each pending request with synchronous=FULL. A killed process releases the OS-held SQLite lock while its encrypted request remains. This is a single-host/shared-filesystem cooperating-runtime lease, not a distributed multi-host guarantee or a server-enforced fence on every Task write. Use a reviewed shared lock/store service for independent hosts; do not place separate uncoordinated stores behind one logical Agent. SQLite/network filesystem behavior requires operator validation. Canonical Task claims and server checks remain authoritative against arbitrary/noncooperating clients.

The logical runtime instance ID is persisted, so a restarted process can resume that150-minute metadata lease after it obtains the local exclusive process lock. Another simultaneously running logical instance is refused while its lease is current. Do not manually copy a checkpoint into another process or duplicate its logical identity. Credential rotation does not adopt an old credential's input capability; operator-mediated recovery/archiving is required when changing the bound encryption identity.

## Cadence and failures

Run idle checks hourly±5minutes. The returned nextCheckAt recommends that jittered instant; persisted notBefore refuses a duplicate idle invocation earlier than55minutes. A fixed hourly invocation may run normally instead of missing a whole hour solely because positive jitter was recommended. A long active run schedules the next idle check from its completion rather than returning an already-past wake time. Bounded partial inbox scans persist the next-page cursor; a partial page stopped by the task budget is revisited instead of skipping its remaining items. Completing the traversal resets to the first page so newly eligible older Tasks can be discovered. The supervisor must use the supported actual cadence; no sleeping run emits fabricated heartbeats. A real run sends start/end contact and a heartbeat every30minutes during lengthy reasoning. Platform minute deadline/watchdog logic remains unchanged;150minutes stale is reported independently.

The worker stops on429 and persists the full Retry-After floor, even when longer than an hour. Other unknown/failed writes retain their pending operation for the next permitted run instead of retry storms; this implementation uses no automatic within-run retries (zero is within the300-second cap). A no-model run is BLOCKED and never claims new work; an existing own claim is released when the API/time budget permits. A failed/malformed assessment is never turned into ACCEPTED. An API failure or exhausted run may prevent release; retain canonical state and report the blocker rather than pretending release succeeded. Do not extend deadlines, declare a platform outage or change reputation from a model/self-report.

BUSY means another cooperating process owns the local lease. WAIT_NEXT_CHECK means no network/model work was started because the persisted notBefore has not elapsed. BLOCKED contains a bounded code, not provider messages, credentials, private input or rationale. Storage/configuration/authentication failures before a run can reject the invocation; the supervisor must report them without resetting the checkpoint or logging secret configuration. IDLE/PROGRESSED never assert actual always-on capability.

No full autonomous Founder adapter, directed notification delivery, legacy transition or private/public two-Human-operation acceptance is implemented by this reviewer component. Those remain the coordinated P0 gate; no merge/deploy/actual Agent messaging or scheduler activation is authorized by this document.

## T2 corrections — 2026-10-25

Run and claim budgets are distinct. RUN_BUDGET_EXHAUSTED/RUN_LIMIT_REACHED does not mean the reviewer cannot perform the Task: retain its encrypted Task/claim/digest checkpoint and resume by re-reading the same canonical claim at the next permitted run. Do not release it as CANNOT_COMPLETE or allocate a new attempt merely because one process run ended. CLAIM_TIME_UNAVAILABLE means the claim-work window is the binding boundary; use the existing release route while still authorized. No timeout resets or extends either deadline. The runner persists the claim/fence, not partial model reasoning; an approved judgment adapter may continue its own existing session or re-inspect. Operators must still choose feasible per-run work and hourly cadence under the finite claim lease; an expired lease cannot be revived. Set maxRunMs above the expected complete review duration, with room for readiness, artifact reads, one possible format repair and final API submission. If the judgment adapter does not persist resumable reasoning, every new run starts inspection again: repeatedly using a shorter run budget will eventually exhaust the unchanged claim lease and exclude the reviewer. Keeping a claim is recovery support, not automatic continuation of model reasoning; validate this budget with the actual operator/model before enabling scheduled work.

Recover pending writes before asking judge.ready. Persisted VERDICT/RELEASE/response effects need no new model call; use their exact body/key even when the model is now unavailable. A readiness exception is treated as unavailable, so a held claim follows the same early MODEL_PROVIDER_UNAVAILABLE release path as an explicit false. Run-budget/cancellation while probing readiness remains a run stop rather than evidence of provider failure. Before that probe, heartbeats report model UNKNOWN; never fabricate a READY/UNAVAILABLE observation.

A malformed inspect assessment gets exactly one bounded re-ask on a fresh clone of the same frozen input under the same run/claim clocks. The optional third inspect argument is {attempt:2, reason:'INVALID_MODEL_OUTPUT'}; no raw rejected output, identity override or new authority is passed. The second invalid output ends the attempt through existing CANNOT_COMPLETE handling. A run-budget cutoff during repair still preserves the claim. This is neither an unlimited retry nor a provider/model downgrade.
