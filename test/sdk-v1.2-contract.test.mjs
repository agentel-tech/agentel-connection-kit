import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AgentelConnector } from "../dist/agentel-connector.js";

function connectorWithCapture() {
  const calls = [];
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_founder",
    apiKey: "agentel_test_key",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, requests: [], events: [], messages: [], cursor: 0, nextCursor: 0, hasMore: false }), { status: 200 });
    },
  });
  return { connector, calls };
}

test("1.2.0 Topic creation maps typed fields and Idempotency-Key to the canonical API", async () => {
  const { connector, calls } = connectorWithCapture();
  await connector.createTopic({ title: "Agent evidence", prompt: "What counts as evidence?", description: "Compare reviewable evidence shapes.", primaryCategory: "ai-agents", language: "en", contributionTypes: ["take", "evidence"] }, "topic-key-1");
  assert.equal(calls[0].url, "https://agentel.test/api/v1/community/topics");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).get("Idempotency-Key"), "topic-key-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: "Agent evidence", prompt: "What counts as evidence?", description: "Compare reviewable evidence shapes.", primary_category: "ai-agents", language: "en", contribution_types: ["take", "evidence"] });
});

test("1.2.0 keeps Mission draft, approval-gated publish, workspace, and room routes distinct", async () => {
  const { connector, calls } = connectorWithCapture();
  await connector.createMissionDraft({ contract: { schema: "agentel.mission", schema_version: "1.1" }, creationRequestId: "request_1" }, "draft-key-1");
  await connector.validateMissionDraft("mission_1");
  await connector.publishMissionDraft("mission_1", "publish-key-1");
  await connector.missionWorkspace("mission_1");
  await connector.sendMissionRoomMessage("mission_1", { type: "QUESTION", audience: "AUTHORITY", content: "Please clarify the acceptance rule." }, "room-key-1");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/v1/missions", "/api/v1/missions/mission_1/validate", "/api/v1/missions/mission_1/publish", "/api/v1/missions/mission_1/workspace", "/api/v1/missions/mission_1/room/messages"]);
  assert.equal(new Headers(calls[2].init.headers).get("Idempotency-Key"), "publish-key-1");
  assert.equal(JSON.parse(calls[4].init.body).audience_type, "AUTHORITY");
});

test("1.2.0 exposes request events and invitation response without collapsing Human approval", async () => {
  const { connector, calls } = connectorWithCapture();
  await connector.missionCreationEvents({ cursor: 2, limit: 10 });
  await connector.acceptMissionCreationRequest("request_1", "accept-key-1");
  await connector.respondToMissionCreationInvitation({ requestId: "request_1", participantId: "participant_1", decision: "ACCEPT", note: "Ready." }, "response-key-1");
  assert.equal(calls[0].url, "https://agentel.test/api/v1/mission-creation-events?cursor=2&limit=10");
  assert.equal(new Headers(calls[1].init.headers).get("Idempotency-Key"), "accept-key-1");
  assert.deepEqual(JSON.parse(calls[2].init.body), { request_id: "request_1", participant_id: "participant_1", decision: "ACCEPT", note: "Ready." });
});

test("1.2.0 preserves official onboarding access alongside paid direct messages", async () => {
  const declarations = await readFile(new URL("../dist/agentel-connector.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /officialWelcome\?: AgentelDirectMessage/);
  assert.match(declarations, /type: "DIRECT" \| "OFFICIAL_WELCOME"/);
  assert.match(declarations, /accessMode: "DIRECT_MESSAGES" \| "OFFICIAL_MESSAGES_ONLY"/);
  assert.match(declarations, /historyDays: number \| null/);
});
