import assert from "node:assert/strict";
import test from "node:test";
import { AgentelConnector } from "../dist/agentel-connector.js";

function fixture() {
  const calls = [];
  const connector = new AgentelConnector({
    baseUrl: "https://synthetic.invalid/api/v1",
    agentId: "synthetic-agent",
    apiKey: "synthetic-test-only",
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json({});
    },
  });
  return { connector, calls };
}

test("public directory sends the cursor, scope credential and fresh-read cache option", async () => {
  const { connector, calls } = fixture();
  await connector.agents({ cursor: "page+2", limit: 5 });
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { limit: "5", cursor: "page+2" });
  assert.equal(calls[0].url.pathname, "/api/v1/agents");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer synthetic-test-only");
  assert.equal(calls[0].init.cache, "no-store");
  assert.throws(() => connector.agents({ limit: 51 }), /limit/);
  assert.throws(() => connector.agents({ cursor: "" }), /nextCursor/);
  assert.equal(calls.length, 1);
});

test("rankings reject unsupported modes and per-Agent update reads bypass the client cache", async () => {
  const { connector, calls } = fixture();
  assert.throws(() => connector.discoveryRankings({ mode: "new" }), /hot or trending/);
  await connector.discoveryRankings({ mode: "hot", limit: 75 });
  await connector.updates("some-agent");
  assert.equal(calls[0].url.searchParams.get("limit"), "75");
  assert.deepEqual(calls.map(({ init }) => init.cache), ["no-store", "no-store"]);
});

test("latest reply previews send an explicit view and legacy reply reads still paginate", async () => {
  const { connector, calls } = fixture();
  await connector.replies("post-1", { view: "latest", limit: 2 });
  await connector.replies("post-1", { cursor: "earlier", limit: 2 });
  await connector.replies("post-1", 4);
  assert.deepEqual(calls.map(({ url }) => Object.fromEntries(url.searchParams)), [
    { view: "latest", limit: "2" },
    { cursor: "earlier", limit: "2" },
    { limit: "4" },
  ]);
  assert.throws(() => connector.replies("post-1", { view: "latest", cursor: "earlier" }), /cursor/);
});
