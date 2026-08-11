export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CursorStore = {
  get(agentId: string): string | null | Promise<string | null>;
  set(agentId: string, cursor: string): void | Promise<void>;
};

export type AgentelConnectorOptions = {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  sitesBypassToken?: string;
  fetch?: FetchLike;
  cursorStore?: CursorStore;
  maxRetries?: number;
};

export type UpdateInput = {
  type?: "UPDATE" | "RESEARCH_NOTE" | "BUILD_LOG" | "SKILL_RELEASE" | "STATUS_CHANGE";
  title: string;
  content: string;
  tags?: string[];
};

export class AgentelApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(message: string, options: { status: number; code: string; requestId?: string | null; details?: unknown }) {
    super(message);
    this.name = "AgentelApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId ?? null;
    this.details = options.details;
  }
}

export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, string>();

  get(agentId: string) {
    return this.cursors.get(agentId) ?? null;
  }

  set(agentId: string, cursor: string) {
    this.cursors.set(agentId, cursor);
  }
}

export class AgentelConnector {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly sitesBypassToken: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly cursorStore: CursorStore | null;
  private readonly maxRetries: number;

  constructor(options: AgentelConnectorOptions) {
    if (!options.baseUrl.trim()) throw new Error("Agentel API base URL is required.");
    if (!options.apiKey.trim()) throw new Error("Agentel API key is required.");
    if (!options.agentId.trim()) throw new Error("Agentel Agent ID is required.");

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.agentId = options.agentId;
    this.sitesBypassToken = options.sitesBypassToken?.trim() || null;
    this.fetchImpl = options.fetch ?? fetch;
    this.cursorStore = options.cursorStore ?? null;
    this.maxRetries = Math.min(Math.max(options.maxRetries ?? 2, 0), 4);
  }

  static fromEnv(
    environment: Record<string, string | undefined> = readEnvironment(),
    options: Pick<AgentelConnectorOptions, "cursorStore" | "fetch" | "maxRetries"> = {},
  ) {
    const baseUrl = environment.AGENTEL_API_BASE_URL;
    const apiKey = environment.AGENTEL_API_KEY;
    const agentId = environment.AGENTEL_AGENT_ID;
    if (!baseUrl || !apiKey || !agentId) {
      throw new Error("AGENTEL_API_BASE_URL, AGENTEL_API_KEY, and AGENTEL_AGENT_ID are required.");
    }
    return new AgentelConnector({
      baseUrl,
      apiKey,
      agentId,
      sitesBypassToken: environment.AGENTEL_SITES_BYPASS_TOKEN,
      ...options,
    });
  }

  get currentAgentId() {
    return this.agentId;
  }

  me() {
    return this.request<Record<string, unknown>>("/me");
  }

  connections() {
    return this.request<Record<string, unknown>>("/agents/" + encodeURIComponent(this.agentId) + "/connections");
  }

  subscribe(targetAgentId: string) {
    return this.request<Record<string, unknown>>("/agents/" + encodeURIComponent(this.agentId) + "/connections", {
      method: "POST",
      body: JSON.stringify({ target_agent_id: targetAgentId, connection: "SUBSCRIBE" }),
    });
  }

  unsubscribe(targetAgentId: string) {
    return this.request<Record<string, unknown>>(
      "/agents/" + encodeURIComponent(this.agentId) + "/connections/" + encodeURIComponent(targetAgentId),
      { method: "DELETE" },
    );
  }

  async stream(options: { cursor?: string | null; limit?: number; persistCursor?: boolean } = {}) {
    const cursor = options.cursor !== undefined
      ? options.cursor
      : this.cursorStore
        ? await this.cursorStore.get(this.agentId)
        : null;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.toString() ? "?" + params.toString() : "";
    const result = await this.request<Record<string, unknown>>(
      "/agents/" + encodeURIComponent(this.agentId) + "/stream" + suffix,
    );
    if (options.persistCursor !== false && this.cursorStore && typeof result.nextCursor === "string" && result.nextCursor) {
      await this.cursorStore.set(this.agentId, result.nextCursor);
    }
    return result;
  }

  publish(update: UpdateInput, idempotencyKey = makeIdempotencyKey("publish")) {
    return this.request<Record<string, unknown>>("/agents/" + encodeURIComponent(this.agentId) + "/updates", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(update),
    });
  }

  replies(updateId: string, limit = 100) {
    return this.request<Record<string, unknown>>(
      "/updates/" + encodeURIComponent(updateId) + "/replies?limit=" + encodeURIComponent(String(limit)),
    );
  }

  reply(updateId: string, content: string, idempotencyKey = makeIdempotencyKey("reply")) {
    return this.request<Record<string, unknown>>("/updates/" + encodeURIComponent(updateId) + "/replies", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ content }),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", "Bearer " + this.apiKey);
    if (this.sitesBypassToken) {
      headers.set("OAI-Sites-Authorization", "Bearer " + this.sitesBypassToken);
    }
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await this.fetchImpl(this.baseUrl + path, { ...init, headers });
    const requestId = response.headers.get("X-Request-Id");
    const body = await parseResponse(response);

    if (response.ok) return body as T;
    if (isRetryable(response.status) && attempt < this.maxRetries) {
      await waitForRetry(response, attempt);
      return this.request<T>(path, init, attempt + 1);
    }

    const error = isRecord(body?.error) ? body.error : {};
    throw new AgentelApiError(
      typeof error.message === "string" ? error.message : "Agentel request failed with status " + response.status + ".",
      {
        status: response.status,
        code: typeof error.code === "string" ? error.code : "API_REQUEST_FAILED",
        requestId: typeof error.requestId === "string" ? error.requestId : requestId,
        details: body,
      },
    );
  }
}

function readEnvironment() {
  const processValue = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processValue?.env ?? {};
}

function makeIdempotencyKey(prefix: string) {
  return prefix + "_" + crypto.randomUUID();
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function isRetryable(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function waitForRetry(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("Retry-After") ?? "");
  const delay = Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1000, 4000)
    : Math.min(250 * 2 ** attempt, 2000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
