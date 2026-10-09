import assert from "node:assert/strict";
import test from "node:test";
test('event cursors survive runtimes without URLSearchParams.size', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(URLSearchParams.prototype,'size');
  const seen=[];
  const sdk=new AgentelConnector({baseUrl:'https://fixture.invalid/api/v1',agentId:'fixture',apiKey:'fixture_key',fetch:async(url)=>{seen.push(String(url));return Response.json({ok:true});}});
  try {
    delete URLSearchParams.prototype.size;
    await sdk.missionEvents('m1',{cursor:7,limit:20});
    await sdk.missionCreationEvents({cursor:9,limit:15});
    assert.equal(new URL(seen[0]).searchParams.get('cursor'),'7');
    assert.equal(new URL(seen[0]).searchParams.get('limit'),'20');
    assert.equal(new URL(seen[1]).searchParams.get('cursor'),'9');
    assert.equal(new URL(seen[1]).searchParams.get('limit'),'15');
  } finally { if(descriptor)Object.defineProperty(URLSearchParams.prototype,'size',descriptor); }
});
import { AgentelApiError, AgentelConnector } from "../dist/agentel-connector.js";

const origin = "https://agentel.test/api/v1";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const makeConnector = (fetch) => new AgentelConnector({ baseUrl: origin, agentId: "agent-test", apiKey: "test-key", fetch, maxRetries: 0 });

test("communityMission routes only COLLAB_V1 read mismatch to sanitized public projection", async () => {
  const seen = [];
  const connector = makeConnector(async (input) => {
    const path = new URL(input).pathname;
    seen.push(path);
    if (path.endsWith("/community/missions/m1")) return json({ error: { code: "MISSION_WORKFLOW_MISMATCH", message: "COLLAB_V1" } }, 409);
    if (path.endsWith("/missions/m1/public")) return json({ source: "public_mission_projection", mission: { id: "m1", workflowVersion: "COLLAB_V1", recruitmentOpen: true }, publicTimeline: [], publicWorks: [] });
    throw Error(`Unexpected read: ${path}`);
  });
  const detail = await connector.communityMission("m1");
  assert.equal(detail.source, "public_mission_projection");
  assert.deepEqual(seen, ["/api/v1/community/missions/m1", "/api/v1/missions/m1/public"]);
});

test("legacy detail does not fall back and private COLLAB_V1 keeps its original access explanation", async () => {
  const legacy = makeConnector(async () => json({ mission: { id: "legacy" }, acceptances: [], submissions: [], activity: [], agentProgress: [] }));
  assert.equal((await legacy.communityMission("legacy")).mission.id, "legacy");
  let reads = 0;
  const hidden = makeConnector(async (input) => {
    reads += 1;
    return new URL(input).pathname.endsWith("/public")
      ? json({ error: { code: "MISSION_NOT_FOUND", message: "Hidden" } }, 404)
      : json({ error: { code: "MISSION_WORKFLOW_MISMATCH", message: "Wait for Founder invitation" } }, 409);
  });
  await assert.rejects(hidden.communityMission("private"), error => error instanceof AgentelApiError && error.code === "MISSION_WORKFLOW_MISMATCH");
  assert.equal(reads, 2);
});

test("closed public COLLAB_V1 remains readable when legacy route reports MISSION_NOT_OPEN", async () => {
  const connector = makeConnector(async (input) => new URL(input).pathname.endsWith("/public")
    ? json({ source: "public_mission_projection", mission: { id: "closed", workflowVersion: "COLLAB_V1", recruitmentOpen: false }, publicTimeline: [], publicWorks: [] })
    : json({ error: { code: "MISSION_NOT_OPEN", message: "Closed", details: { workflowVersion: "COLLAB_V1" } } }, 409));
  const detail = await connector.communityMission("closed");
  assert.equal(detail.mission.recruitmentOpen, false);
});

test("participant path uses typed COLLAB_V1 routes, exact acknowledgement, stable keys and separate evidence", async () => {
  const writes = [];
  const connector = makeConnector(async (input, init = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === "POST") writes.push({ path, key: headers.get("Idempotency-Key"), body });
    assert.equal(headers.get("Authorization"), "Bearer test-key");
    if (method === "GET" && path.endsWith("/applications")) return json({ mission: { id: "m1", workflowVersion: "COLLAB_V1" }, contract: { stages: [{ stageId: "s1", roleSlots: [{ slotId: "slot1" }] }] }, applications: [], audience: "DISCOVERY" });
    if (method === "POST" && path.endsWith("/applications")) return json({ applicationId: "app1", assignmentId: "a1", status: "JOINED", created: true }, 201);
    if (method === "POST" && path.endsWith("/assignments/a1/accept")) return json({ assignmentId: "a1", missionId: "m1", status: "ACCEPTED", accepted: true, created: true }, 201);
    if (method === "GET" && path.endsWith("/workspace")) return json({ mission: { id: "m1" }, state: "ACTIVE_WORK", startupWait: null, assignment: { id: "a1", status: "ACTIVE" }, nextActions: [] });
    if (method === "GET" && path.endsWith("/events")) return json({ missionId: "m1", events: [], cursor: 7, nextCursor: null, hasMore: false });
    if (method === "GET" && path.endsWith("/deliveries")) return json({ missionId: "m1", deliveries: [], audience: "AGENT_PRIVATE" });
    if (method === "POST" && path.endsWith("/deliveries")) return json({ delivery: { id: "d1", status: "SUBMITTED", assignmentId: "a1" }, submissionCheck: { evidenceRequired: true, evidenceComplete: false }, created: true }, 201);
    if (method === "POST" && path.endsWith("/deliveries/d1/evidence")) return json({ evidence: { id: "e1", deliveryId: "d1", reviewStatus: "UNREVIEWED" }, created: true }, 201);
    throw Error(`Unexpected request: ${method} ${path}`);
  });
  const preview = await connector.missionApplications("m1");
  const slot = preview.contract.stages[0].roleSlots[0];
  const application = await connector.applyToMission("m1", { stageId: "s1", slotId: slot.slotId, application: { message: "Real task" } }, "apply-stable");
  assert.equal(application.assignmentId, "a1");
  await connector.acceptMissionAssignment("m1", "a1", { contractVersion: "1.0", contractHash: "sha256:contract" }, "accept-stable");
  assert.equal((await connector.missionWorkspace("m1")).assignment.status, "ACTIVE");
  assert.deepEqual((await connector.missionEvents("m1", { cursor: 7, limit: 20 })).events, []);
  assert.deepEqual((await connector.missionDeliveries("m1")).deliveries, []);
  const result = await connector.submitMissionDelivery("m1", { assignmentId: "a1", title: "Result", summary: "Verified source summary", artifactType: "report", payload: { result: "Real output" } }, "deliver-stable");
  assert.equal(result.submissionCheck.evidenceComplete, false);
  await connector.attachMissionEvidence("m1", result.delivery.id, { title: "Sources", structuredSummary: "Primary source and method", sourceUrls: ["https://example.test/source"] }, "evidence-stable");
  assert.deepEqual(writes.map(({ key }) => key), ["apply-stable", "accept-stable", "deliver-stable", "evidence-stable"]);
  assert.deepEqual(writes[0].body, { stage_id: "s1", slot_id: "slot1", application: { message: "Real task" } });
  assert.deepEqual(writes[1].body, { accepted_terms: true, contract_version: "1.0", contract_hash: "sha256:contract" });
  assert.equal(writes[2].body.assignment_id, "a1");
  assert.equal(writes[3].body.evidence_package.structured_summary, "Primary source and method");
});

test("invalid COLLAB_V1 writes fail before network access", async () => {
  let calls = 0;
  const connector = makeConnector(async () => { calls += 1; return json({}); });
  assert.throws(() => connector.applyToMission("m1", { stageId: "", slotId: "slot" }, "key"), /Stage/);
  assert.throws(() => connector.applyToMission("m1", { stageId: "s", slotId: "slot", application: [] }, "key"), /JSON object/);
  assert.throws(() => connector.acceptMissionAssignment("m1", "a1", { contractVersion: "", contractHash: "hash" }, "key"), /version/);
  assert.throws(() => connector.missionEvents("m1", { cursor: -1 }), /cursor/);
  assert.throws(() => connector.submitMissionDelivery("m1", { assignmentId: "a1", title: "", summary: "Summary", artifactType: "report" }, "key"), /title/);
  assert.equal(calls, 0);
});

test("a failed consequential write is not auto-retried and preserves the server nextAction", async () => {
  let calls = 0;
  const connector = new AgentelConnector({ baseUrl: origin, agentId: "agent-test", apiKey: "test-key", maxRetries: 2,
    fetch: async () => { calls += 1; return json({ error: { code: "MISSION_STAFFING_UNAVAILABLE", message: "Retry after reading workspace", details: { nextAction: "READ_WORKSPACE" } } }, 503); } });
  await assert.rejects(connector.acceptMissionAssignment("m1", "a1", { contractVersion: "1.0", contractHash: "hash" }, "stable-key"),
    error => error instanceof AgentelApiError && error.code === "MISSION_STAFFING_UNAVAILABLE" && error.details.error.details.nextAction === "READ_WORKSPACE");
  assert.equal(calls, 1);
});

test("APPROVAL_REQUIRED application remains unassigned until Founder selection", async () => {
  const calls = [];
  const connector = makeConnector(async (input, init = {}) => {
    calls.push({ path: new URL(input).pathname, method: init.method ?? "GET" });
    return json({ applicationId: "app-pending", assignmentId: null, status: "ELIGIBILITY_PASSED", created: true }, 201);
  });
  const result = await connector.applyToMission("m1", { stageId: "s1", slotId: "reviewer" }, "apply-pending");
  assert.equal(result.assignmentId, null);
  assert.equal(result.status, "ELIGIBILITY_PASSED");
  assert.deepEqual(calls, [{ path: "/api/v1/missions/m1/applications", method: "POST" }]);
});
