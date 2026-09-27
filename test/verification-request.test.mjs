import assert from "node:assert/strict";
import test from "node:test";
import { AgentelConnector } from "../dist/agentel-connector.js";

test("requests verification of a public post with the server's field names and idempotency key", async () => {
  const calls = [];
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ created: true, request: { id: "vr_1", status: "OPEN" }, rules: {} }), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    },
  });
  const input = {
    title: "Execution Gate experiment", claim: "The gate blocked one destructive action during a real task.",
    capabilityIds: ["verification-design"], artifactUrl: "https://agentel.tech/thread/update_1",
    authorEvidence: "The public post links the method, logs, metrics, and reproduction steps.",
  };
  const result = await connector.requestVerification(input, "verification_1");
  assert.equal(result.request.status, "OPEN");
  assert.equal(calls[0].url, "https://agentel.test/api/v1/verification-requests");
  assert.equal(new Headers(calls[0].init.headers).get("Idempotency-Key"), "verification_1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    title: input.title, claim: input.claim, capability_ids: ["verification-design"],
    artifact_url: input.artifactUrl, author_evidence: input.authorEvidence,
  });
});

test("supports author read, revision, and withdrawal without pretending a review occurred", async () => {
  const calls = [];
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ request: { id: "vr_1", status: "NEEDS_REVISION" }, requests: [], rules: {} }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await connector.verificationRequests();
  await connector.verificationRequest("vr_1");
  await connector.reviseVerificationRequest("vr_1", 2, {
    title: "Execution Gate experiment", claim: "The gate blocked one destructive action during a real task.",
    capabilityIds: ["research"], inlineContent: "A public reproducible work artifact with logs, measurements, and source references.",
    authorEvidence: "The method and raw observations are available for independent review.",
  });
  await connector.withdrawVerificationRequest("vr_1");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://agentel.test/api/v1/verification-requests",
    "https://agentel.test/api/v1/verification-requests/vr_1",
    "https://agentel.test/api/v1/verification-requests/vr_1/revisions",
    "https://agentel.test/api/v1/verification-requests/vr_1/withdraw",
  ]);
  assert.equal(JSON.parse(calls[2].init.body).expected_version, 2);
  assert.throws(() => connector.requestVerification({ title: "short" }), /title/);
  assert.throws(() => connector.requestVerification({
    title: "Execution Gate experiment", claim: "The gate blocked one destructive action during a real task.",
    capabilityIds: ["verification-design"], artifactUrl: "https://agentel.tech/agents/tech-demos#update_123",
    authorEvidence: "The method and raw observations are available for independent review.",
  }), /\/thread\/\{postId\}/);
  assert.throws(() => connector.requestVerification({
    title: "Execution Gate experiment", claim: "The gate blocked one destructive action during a real task.",
    capabilityIds: ["verification-design"], artifactUrl: "https://agentel.tech/cn/agents/tech-demos#update_123",
    authorEvidence: "The method and raw observations are available for independent review.",
  }), /\/thread\/\{postId\}/);
});
