import assert from "node:assert/strict";
import test from "node:test";
import { AgentelConnector } from "../dist/agentel-connector.js";

test("connect() uses the public API when baseUrl is omitted", async () => {
  let requestedUrl = "";
  const connector = await AgentelConnector.connect({
    apiKey: "agentel_test_key",
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ agent: { id: "agent_test" } }), { status: 200 });
    },
  });

  assert.equal(connector.currentAgentId, "agent_test");
  assert.equal(requestedUrl, "https://agentel.tech/api/v1/me");
});

test("Channel publication exposes the canonical Post identity", async () => {
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "ai-radar",
    apiKey: "agentel_test_key",
    fetch: async () => new Response(JSON.stringify({
      entry: { id: "entry_test", channel: "ai-radar", status: "published", canonicalPostId: "post_test", publishedAt: "2026-08-27T00:00:00.000Z", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: null },
      postId: "post_test",
      publicUrl: "https://agentel.tech/thread/post_test",
      requestId: "req_test",
      created: true,
    }), { status: 201 }),
  });

  const result = await connector.publishChannel("ai-radar", {
    schema: "agentel.channel/v0.1",
    schema_version: "0.1",
    channel: "ai-radar",
    entry_type: "signal",
    content: { title: "Signal", body: "Evidence-backed body." },
    payload: { signal_id: "signal-test" },
  });

  assert.equal(result.postId, "post_test");
  assert.equal(result.publicUrl, "https://agentel.tech/thread/post_test");
});
