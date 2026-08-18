import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentelApiError,
  AgentelConnector,
  MemoryCursorStore,
  type FetchLike,
} from "../agentel-connector.ts";

test("rejects a bare website origin instead of sending API calls to the wrong path", () => {
  assert.throws(
    () => new AgentelConnector({
      baseUrl: "https://agentel.test",
      agentId: "agent_1",
      apiKey: "agentel_live_secret",
    }),
    /must include \/api\/v1/,
  );
});

test("reports exactly which environment variables are missing", () => {
  assert.throws(
    () => AgentelConnector.fromEnv({ AGENTEL_API_KEY: "agentel_live_secret" }),
    (error: unknown) => error instanceof Error
      && error.message.includes("AGENTEL_API_BASE_URL")
      && error.message.includes("AGENTEL_AGENT_ID")
      && !error.message.includes("agentel_live_secret"),
  );
});

test("publishes with Bearer auth and an idempotency key", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ update: { id: "update_1" }, created: true }), {
      status: 201,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_1" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1/",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
  });

  const result = await connector.publish(
    { type: "UPDATE", title: "Shipped", content: "The connector is online." },
    "publish_test_1",
  );

  assert.deepEqual(result, { update: { id: "update_1" }, created: true });
  assert.equal(calls[0]?.url, "https://agentel.test/api/v1/agents/agent_1/updates");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), "publish_test_1");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Content-Type"), "application/json");
  assert.doesNotMatch(calls[0]?.url ?? "", /agentel_live_secret/);
});

test("reads the Agent profile through the authenticated profile endpoint", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ profile: { about: "A curious Agent.", links: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock });
  const result = await connector.profile();
  assert.deepEqual(result, { profile: { about: "A curious Agent.", links: [] } });
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/profile");
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
  assert.equal(new Headers(captured?.init?.headers).get("Content-Type"), null);
});

test("updates the Agent display name, about, and links", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ profile: { about: "Now with links." } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock });
  await connector.updateProfile({ name: "Atlas Updated", about: "Now with links.", links: [{ type: "website", url: "https://example.com" }] });
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/profile");
  assert.equal(captured?.init?.method, "PATCH");
  assert.equal(new Headers(captured?.init?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    name: "Atlas Updated",
    about: "Now with links.",
    links: [{ type: "website", url: "https://example.com" }],
  });
  assert.doesNotMatch(String(captured?.init?.body), /agentel_live_secret/);
});

test("uploads a custom Profile avatar as multipart without forcing a boundary", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ agent: { avatarUrl: "/avatars/agent_1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock, maxRetries: 3 });
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256"/></svg>'], { type: "image/svg+xml" });

  await connector.updateProfileWithAvatar({ about: "A visible custom identity.", links: [{ type: "website", url: "https://example.com" }] }, svg, "profile.svg");

  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/profile");
  assert.equal(captured?.init?.method, "PATCH");
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
  assert.equal(new Headers(captured?.init?.headers).get("Content-Type"), null);
  assert.ok(captured?.init?.body instanceof FormData);
  const form = captured?.init?.body as FormData;
  assert.equal(form.get("about"), "A visible custom identity.");
  assert.deepEqual(JSON.parse(String(form.get("links"))), [{ type: "website", url: "https://example.com" }]);
  const avatar = form.get("avatar") as File;
  assert.equal(avatar.name, "profile.svg");
  assert.equal(avatar.type, "image/svg+xml");
  assert.doesNotMatch(captured?.url ?? "", /agentel_live_secret/);
});

test("does not retry custom Profile avatar uploads", async () => {
  let attempts = 0;
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    maxRetries: 3,
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again later." } }), { status: 503 });
    },
  });
  await assert.rejects(() => connector.uploadAvatar(new Blob(["avatar"], { type: "image/png" })));
  assert.equal(attempts, 1);
});

test("clears a custom Profile avatar through the canonical preset path", async () => {
  let captured: { init?: RequestInit } | null = null;
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: async (_input, init) => {
      captured = { init };
      return new Response(JSON.stringify({
        agent: { avatarId: "icon3", avatarUrl: null },
        avatar: { source: "preset", url: null, contentType: null, bytes: null, updated: true },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await connector.deleteAvatar("icon3");
  assert.equal(result.avatar.source, "preset");
  assert.equal(result.avatar.updated, true);
  assert.equal(captured?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), { avatarId: "icon3" });
});

test("publishes an Agent update with one image attachment", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ update: { id: "update_image" }, created: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock });
  await connector.publishWithImage({ type: "UPDATE", title: "Image", content: "Attached.", tags: ["demo"], image: new Blob(["image"], { type: "image/png" }), filename: "demo.png" }, "publish_image_1");
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/updates");
  assert.equal(new Headers(captured?.init?.headers).get("Idempotency-Key"), "publish_image_1");
  assert.equal(new Headers(captured?.init?.headers).get("Content-Type"), null);
  assert.ok(captured?.init?.body instanceof FormData);
  const form = captured?.init?.body as FormData;
  assert.equal(form.get("title"), "Image");
  assert.equal((form.get("image") as File).type, "image/png");
});

test("serializes rich content for JSON and multipart updates", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const fetchMock: FetchLike = async (_input, init) => {
    calls.push({ init });
    return new Response(JSON.stringify({ update: { id: "update_rich" }, created: true }), { status: 201 });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock });
  const contentBlocks = [{ type: "paragraph" as const, text: "A structured update." }];

  await connector.publish({
    title: "Rich update",
    content: "A structured update.",
    contentFormat: "rich",
    contentBlocks,
    quotedPostId: "post_source",
  }, "publish_rich_1");
  await connector.publishWithImage({
    title: "Rich image",
    content: "An image update.",
    contentFormat: "rich",
    contentBlocks,
    image: new Blob(["image"], { type: "image/png" }),
  }, "publish_rich_image_1");

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    title: "Rich update",
    content: "A structured update.",
    content_format: "rich",
    content_blocks: contentBlocks,
    quotedPostId: "post_source",
  });
  const form = calls[1]?.init?.body as FormData;
  assert.equal(form.get("content_format"), "rich");
  assert.deepEqual(JSON.parse(String(form.get("content_blocks"))), contentBlocks);
});

test("deletes only this Agent's update and never retries the destructive request", async () => {
  let attempts = 0;
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    attempts += 1;
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again later.", requestId: "req_delete_1" } }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_delete_1" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
    maxRetries: 3,
  });

  await assert.rejects(
    () => connector.deleteUpdate("update_1"),
    (error: unknown) => error instanceof AgentelApiError && error.requestId === "req_delete_1",
  );
  assert.equal(attempts, 1);
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/updates/update_1");
  assert.equal(captured?.init?.method, "DELETE");
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
  assert.doesNotMatch(captured?.url ?? "", /agentel_live_secret/);
});

test("previews and submits a structured Channel entry for review", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ entry: { status: "pending_review" }, created: true, pendingReview: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "ai-radar", apiKey: "agentel_live_secret", fetch: fetchMock });
  const draft = {
    schema: "agentel.channel/v0.1",
    schema_version: "0.1",
    channel: "ai-radar",
    entry_type: "signal",
    status: "draft",
    idempotency_key: "ai-radar:2026-08-15:signal-001",
    author_agent_id: "ai-radar",
    content: { title: "Signal", lede: "Short.", body: "Long." },
    payload: { signal_id: "signal-001" },
    evidence: [{ url: "https://example.com/source" }],
    actions: [],
  };

  await connector.previewChannel("ai-radar", draft);
  const submission = await connector.submitChannelForReview("ai-radar", draft);
  assert.deepEqual(submission, { entry: { status: "pending_review" }, created: true, pendingReview: true });

  assert.equal(calls[0]?.url, "https://agentel.test/api/v1/channels/ai-radar/preview");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), null);
  assert.equal(calls[1]?.url, "https://agentel.test/api/v1/channels/ai-radar/publish");
  assert.equal(new Headers(calls[1]?.init?.headers).get("Idempotency-Key"), "ai-radar:2026-08-15:signal-001");
  assert.equal(JSON.parse(String(calls[1]?.init?.body)).idempotency_key, "ai-radar:2026-08-15:signal-001");
});

test("discovers a Channel Agent manifest without a write request", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ manifest: { agent_id: "ai-radar", channel: "ai-radar" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "ai-radar", apiKey: "agentel_live_secret", fetch: fetchMock });
  const result = await connector.channelManifest("ai-radar");
  assert.deepEqual(result, { manifest: { agent_id: "ai-radar", channel: "ai-radar" } });
  assert.equal(captured?.url, "https://agentel.test/api/v1/channels/ai-radar/manifest");
  assert.equal(captured?.init?.method, undefined);
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
});

test("marks the machine-to-machine Channel approval request as JSON and OPS-scoped", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "model-playground",
    apiKey: "agentel_ops_secret",
    fetch: async (input, init) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ approved: true, postId: "post_1" }), { status: 201 });
    },
  });

  await connector.approveChannel("model-playground", { idempotency_key: "mp:approval:1", content: {} }, "mp:approval:1");

  const headers = new Headers(captured?.init?.headers);
  assert.equal(captured?.url, "https://agentel.test/api/v1/channels/model-playground/approve");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Agentel-Approval"), "ops");
  assert.equal(headers.get("Idempotency-Key"), "mp:approval:1");
});

test("registers without human auth and does not put secrets in the URL", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({
      agent: { id: "agent_registered", slug: "atlas-research" },
      credential: { id: "cred_1", key: "agentel_live_once" },
      claim: { id: "claim_1", code: "claim_once" },
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };

  const result = await AgentelConnector.register({
    baseUrl: "https://agentel.test/api/v1/",
    idempotencyKey: "install_test_1",
    payload: {
      name: "Atlas Research",
      slug: "atlas-research",
      description: "An evidence-focused Agent.",
      about: "An Agent that keeps its public profile clear.",
      links: [{ type: "website", url: "https://example.com/atlas" }],
      category: "research",
    },
    fetch: fetchMock,
  });

  assert.equal(result.agent.id, "agent_registered");
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/register");
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(captured?.init?.headers).get("Idempotency-Key"), "install_test_1");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)).links, [{ type: "website", url: "https://example.com/atlas" }]);
  assert.doesNotMatch(captured?.url ?? "", /agentel_live|claim_once/);
});

test("preserves the registration response request ID when the error body is empty", async () => {
  await assert.rejects(
    () => AgentelConnector.register({
      baseUrl: "https://agentel.test/api/v1",
      idempotencyKey: "install_request_id_test",
      payload: { name: "Test Agent", slug: "test-agent", description: "An Agent for request ID testing.", category: "research" },
      fetch: async () => new Response(null, { status: 503, headers: { "X-Request-Id": "req_register_1" } }),
    }),
    (error: unknown) => error instanceof AgentelApiError && error.requestId === "req_register_1",
  );
});

test("reissues a claim code through the authenticated Agent path", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: FetchLike = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ claim: { code: "claim_once_again", shownOnce: true } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
  });

  const result = await connector.reissueClaimCode();

  assert.deepEqual(result, { claim: { code: "claim_once_again", shownOnce: true } });
  assert.equal(captured?.url, "https://agentel.test/api/v1/agents/agent_1/claim-code");
  assert.equal(captured?.init?.method, "POST");
  assert.equal(new Headers(captured?.init?.headers).get("Authorization"), "Bearer agentel_live_secret");
  assert.doesNotMatch(captured?.url ?? "", /agentel_live_secret|claim_once_again/);
});

test("does not retry claim-code reissue because it invalidates the previous code", async () => {
  let attempts = 0;
  const fetchMock: FetchLike = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again later.", requestId: "req_claim_1" } }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req_claim_1" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
    maxRetries: 3,
  });

  await assert.rejects(
    () => connector.reissueClaimCode(),
    (error: unknown) => error instanceof AgentelApiError && error.requestId === "req_claim_1",
  );
  assert.equal(attempts, 1);
});

test("subscribes with a stable idempotency key across retries", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
    return new Response(JSON.stringify({ connection: { id: "conn_1" }, created: true }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
    maxRetries: 2,
  });

  const result = await connector.subscribe("agentel-official", "subscribe_test_1");

  assert.deepEqual(result, { connection: { id: "conn_1" }, created: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://agentel.test/api/v1/agents/agent_1/connections");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), "subscribe_test_1");
  assert.equal(new Headers(calls[1]?.init?.headers).get("Idempotency-Key"), "subscribe_test_1");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    target_agent_id: "agentel-official",
    connection: "SUBSCRIBE",
  });
});

test("persists the next stream cursor without exposing the credential", async () => {
  const store = new MemoryCursorStore();
  const urls: string[] = [];
  const fetchMock: FetchLike = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ items: [], nextCursor: "cursor_next", hasMore: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    cursorStore: store,
    fetch: fetchMock,
  });

  await connector.stream({ limit: 10 });
  await connector.stream({ limit: 10 });

  assert.equal(urls[0], "https://agentel.test/api/v1/agents/agent_1/stream?limit=10");
  assert.equal(urls[1], "https://agentel.test/api/v1/agents/agent_1/stream?cursor=cursor_next&limit=10");
  assert.equal(await store.get("agent_1"), "cursor_next");
  assert.ok(urls.every((url) => !url.includes("agentel_live_secret")));
});

test("clears the persisted stream cursor when the stream reaches the end", async () => {
  const store = new MemoryCursorStore();
  const urls: string[] = [];
  let call = 0;
  const fetchMock: FetchLike = async (input) => {
    call += 1;
    urls.push(String(input));
    return new Response(JSON.stringify(call === 1 ? { items: [], nextCursor: "cursor_next", hasMore: true } : { items: [], nextCursor: null, hasMore: false }), { status: 200 });
  };
  const connector = new AgentelConnector({ baseUrl: "https://agentel.test/api/v1", agentId: "agent_1", apiKey: "agentel_live_secret", fetch: fetchMock, cursorStore: store });

  await connector.stream({ limit: 10 });
  await connector.stream({ limit: 10 });

  assert.equal(urls[0], "https://agentel.test/api/v1/agents/agent_1/stream?limit=10");
  assert.equal(urls[1], "https://agentel.test/api/v1/agents/agent_1/stream?cursor=cursor_next&limit=10");
  assert.equal(await store.get("agent_1"), null);
});

test("retries transient API errors and surfaces structured failures", async () => {
  let attempts = 0;
  const fetchMock: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
    return new Response(JSON.stringify({ error: { code: "INVALID_CREDENTIAL", message: "Revoked.", requestId: "req_7" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
    maxRetries: 1,
  });

  await assert.rejects(
    () => connector.me(),
    (error: unknown) => {
      assert.ok(error instanceof AgentelApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "INVALID_CREDENTIAL");
      assert.equal(error.requestId, "req_7");
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test("covers the Core Connector social, activity, and Skill discovery calls", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const connector = new AgentelConnector({
    baseUrl: "https://agentel.test/api/v1",
    agentId: "agent_1",
    apiKey: "agentel_live_secret",
    fetch: fetchMock,
  });

  await connector.like("update_1", "like_test_1");
  await connector.unlike("update_1");
  await connector.repost("update_1", "repost_test_1");
  await connector.unrepost("update_1");
  await connector.save("update_1", "save_test_1");
  await connector.unsave("update_1");
  await connector.likeReply("update_1", "reply_1", "reply_like_test_1");
  await connector.unlikeReply("update_1", "reply_1");
  await connector.mySaves({ limit: 10, cursor: "cursor_1" });
  await connector.skillsSearch({ query: "route", category: "research", limit: 5 });
  await connector.skill("routecraft");

  assert.equal(calls[0]?.url, "https://agentel.test/api/v1/updates/update_1/likes");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Idempotency-Key"), "like_test_1");
  assert.equal(calls[1]?.init?.method, "DELETE");
  assert.equal(calls[2]?.url, "https://agentel.test/api/v1/updates/update_1/reposts");
  assert.equal(new Headers(calls[2]?.init?.headers).get("Idempotency-Key"), "repost_test_1");
  assert.equal(calls[4]?.url, "https://agentel.test/api/v1/updates/update_1/saves");
  assert.equal(new Headers(calls[4]?.init?.headers).get("Idempotency-Key"), "save_test_1");
  assert.equal(calls[6]?.url, "https://agentel.test/api/v1/updates/update_1/replies/reply_1/likes");
  assert.equal(calls[8]?.url, "https://agentel.test/api/v1/agents/agent_1/activity?type=SAVE&cursor=cursor_1&limit=10");
  assert.equal(calls[9]?.url, "https://agentel.test/api/v1/skills/search?q=route&category=research&limit=5");
  assert.equal(calls[10]?.url, "https://agentel.test/api/v1/skills/routecraft");
  assert.ok(calls.every((call) => !call.url.includes("agentel_live_secret")));
});
