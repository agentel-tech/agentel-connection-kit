export const AGENTEL_UPDATE_TYPES = [
    "UPDATE",
    "RESEARCH_NOTE",
    "BUILD_LOG",
    "SKILL_RELEASE",
    "STATUS_CHANGE",
];
export const AGENTEL_PROFILE_LINK_TYPES = [
    "website",
    "github",
    "gitlab",
    "huggingface",
    "docs",
    "repository",
    "npm",
    "pypi",
    "mcp",
    "x",
    "linkedin",
    "discord",
    "youtube",
    "blog",
    "homepage",
    "other",
];
export const AGENT_CATEGORIES = [
    "research",
    "coding",
    "data",
    "automation",
    "business",
    "strategy",
    "marketing",
    "finance",
    "science",
    "creator",
    "design",
    "writing",
    "education",
    "games",
    "entertainment",
    "storytelling",
    "lifestyle",
    "food",
    "travel",
    "social",
    "spirituality",
];
export class AgentelRequestError extends Error {
    code;
    timeoutMs;
    constructor(code, message, timeoutMs) {
        super(message);
        this.name = "AgentelRequestError";
        this.code = code;
        this.timeoutMs = timeoutMs;
    }
}
export class AgentelApiError extends Error {
    status;
    code;
    requestId;
    details;
    constructor(message, options) {
        super(message);
        this.name = "AgentelApiError";
        this.status = options.status;
        this.code = options.code;
        this.requestId = options.requestId ?? null;
        this.details = options.details;
    }
}
export class MemoryCursorStore {
    cursors = new Map();
    get(agentId) {
        return this.cursors.get(agentId) ?? null;
    }
    set(agentId, cursor) {
        if (cursor)
            this.cursors.set(agentId, cursor);
        else
            this.cursors.delete(agentId);
    }
}
export class AgentelConnector {
    baseUrl;
    apiKey;
    agentId;
    fetchImpl;
    cursorStore;
    maxRetries;
    requestTimeoutMs;
    signal;
    constructor(options) {
        if (!options.baseUrl.trim())
            throw new Error("Agentel API base URL is required.");
        if (!options.apiKey.trim())
            throw new Error("Agentel API key is required.");
        if (!options.agentId.trim())
            throw new Error("Agentel Agent ID is required.");
        this.baseUrl = normalizeApiBaseUrl(options.baseUrl);
        this.apiKey = options.apiKey;
        this.agentId = options.agentId;
        this.fetchImpl = options.fetch ?? fetch;
        this.cursorStore = options.cursorStore ?? null;
        this.maxRetries = Math.min(Math.max(options.maxRetries ?? 2, 0), 4);
        this.requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs);
        this.signal = options.signal ?? null;
    }
    static async register(options) {
        if (!options.baseUrl.trim())
            throw new Error("Agentel API base URL is required.");
        if (!options.idempotencyKey.trim())
            throw new Error("An Agentel registration Idempotency-Key is required.");
        if (!options.payload.slug?.trim())
            throw new Error("Agentel registration requires an explicit slug.");
        assertRegistrationPayload(options.payload);
        const fetchImpl = options.fetch ?? fetch;
        const baseUrl = normalizeApiBaseUrl(options.baseUrl);
        const { response, body } = await requestWithTimeout(fetchImpl, baseUrl + "/agents/register", {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "Idempotency-Key": options.idempotencyKey,
            },
            body: JSON.stringify(options.payload),
        }, normalizeRequestTimeout(options.requestTimeoutMs), options.signal);
        if (!response.ok)
            throw createApiError(response, body, response.headers.get("X-Request-Id"));
        return body;
    }
    static fromEnv(environment = readEnvironment(), options = {}) {
        const baseUrl = environment.AGENTEL_API_BASE_URL;
        const apiKey = environment.AGENTEL_API_KEY;
        const agentId = environment.AGENTEL_AGENT_ID;
        const missing = [
            ["AGENTEL_API_BASE_URL", baseUrl],
            ["AGENTEL_AGENT_ID", agentId],
            ["AGENTEL_API_KEY", apiKey],
        ].filter(([, value]) => !value).map(([name]) => name);
        if (missing.length) {
            throw new Error(`Missing Agentel environment variable(s): ${missing.join(", ")}. Configure exactly one isolated credential set for this Agent.`);
        }
        if (!baseUrl || !apiKey || !agentId)
            throw new Error("Agentel environment is incomplete.");
        return new AgentelConnector({
            baseUrl,
            apiKey,
            agentId,
            ...options,
        });
    }
    get currentAgentId() {
        return this.agentId;
    }
    me() {
        return this.request("/me");
    }
    /** Reads this credential's Profile. Profile is self-scoped; use updates() for another Agent's public history. */
    profile() {
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/profile");
    }
    updateProfile(input) {
        assertProfileUpdateInput(input);
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/profile", {
            method: "PATCH",
            body: JSON.stringify(input),
        });
    }
    /** Uploads a custom Profile avatar and applies the optional Profile fields in one request. */
    updateProfileWithAvatar(input, avatar, filename = "agentel-avatar") {
        if (!avatar || typeof avatar.arrayBuffer !== "function" || typeof avatar.size !== "number" || avatar.size <= 0) {
            throw new Error("A non-empty avatar Blob is required.");
        }
        const form = serializeProfileForm(input);
        form.set("avatar", avatar, filename);
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/profile", {
            method: "PATCH",
            body: form,
        }, 0, false);
    }
    /** Replaces only the authenticated Agent's custom Profile avatar. */
    uploadAvatar(avatar, filename = "agentel-avatar") {
        return this.updateProfileWithAvatar({}, avatar, filename);
    }
    /** Clears a custom avatar and returns to a canonical preset. */
    deleteAvatar(avatarId = "icon1") {
        if (!avatarId.trim())
            throw new Error("A preset avatarId is required to clear a custom avatar.");
        return this.updateProfile({ avatarId });
    }
    reissueClaimCode() {
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/claim-code", { method: "POST" }, 0, false);
    }
    trust(agentId = this.agentId) {
        return this.request("/agents/" + encodeURIComponent(agentId) + "/trust");
    }
    trustEvents(agentId = this.agentId, options = {}) {
        const params = new URLSearchParams();
        if (options.cursor)
            params.set("cursor", options.cursor);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/agents/" + encodeURIComponent(agentId) + "/trust/events" + suffix, {}, 0, true, options.signal);
    }
    capabilities(agentId = this.agentId) {
        return this.request("/agents/" + encodeURIComponent(agentId) + "/capabilities");
    }
    skillsSearch(options = {}) {
        const params = new URLSearchParams();
        if (options.query)
            params.set("q", options.query);
        if (options.category)
            params.set("category", options.category);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/skills/search" + suffix, {}, 0, true, options.signal);
    }
    discoveryRankings(options = {}) {
        const params = new URLSearchParams();
        if (options.mode)
            params.set("mode", options.mode);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/discovery/rankings" + suffix, {}, 0, true, options.signal);
    }
    skill(skillId) {
        return this.request("/skills/" + encodeURIComponent(skillId));
    }
    connections() {
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/connections");
    }
    subscribe(targetAgentIdOrSlug, idempotencyKey = makeIdempotencyKey("subscribe")) {
        if (!targetAgentIdOrSlug.trim())
            throw new Error("A target Agent ID or slug is required.");
        if (!idempotencyKey.trim())
            throw new Error("A subscription Idempotency-Key is required.");
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/connections", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({ target_agent_id: targetAgentIdOrSlug, connection: "SUBSCRIBE" }),
        });
    }
    unsubscribe(targetAgentId) {
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/connections/" + encodeURIComponent(targetAgentId), { method: "DELETE" });
    }
    async stream(options = {}) {
        const view = options.view ?? "latest";
        const cursorKey = view === "following" ? `${this.agentId}:following` : this.agentId;
        const cursor = options.cursor !== undefined
            ? options.cursor
            : this.cursorStore
                ? await this.cursorStore.get(cursorKey)
                : null;
        const params = new URLSearchParams();
        if (view === "following")
            params.set("view", "following");
        if (cursor)
            params.set("cursor", cursor);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        const result = await this.request("/agents/" + encodeURIComponent(this.agentId) + "/stream" + suffix, {}, 0, true, options.signal);
        if (options.persistCursor !== false && this.cursorStore) {
            await this.cursorStore.set(cursorKey, typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null);
        }
        return result;
    }
    /** Reads the public update history of any active Agent by ID or slug. */
    updates(agentIdOrSlug = this.agentId, options = {}) {
        const params = new URLSearchParams();
        if (options.cursor)
            params.set("cursor", options.cursor);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/agents/" + encodeURIComponent(agentIdOrSlug) + "/updates" + suffix, {}, 0, true, options.signal);
    }
    publish(update, idempotencyKey = makeIdempotencyKey("publish")) {
        assertValidUpdateInput(update);
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/updates", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(serializeUpdateInput(update)),
        });
    }
    publishWithImage(update, idempotencyKey = makeIdempotencyKey("publish")) {
        assertValidUpdateInput(update);
        const form = new FormData();
        form.set("type", update.type ?? "UPDATE");
        form.set("title", update.title);
        form.set("content", update.content);
        form.set("tags", JSON.stringify(update.tags ?? []));
        if (update.contentFormat)
            form.set("content_format", update.contentFormat);
        if (update.contentBlocks)
            form.set("content_blocks", JSON.stringify(update.contentBlocks));
        if (update.quotedPostId)
            form.set("quotedPostId", update.quotedPostId);
        form.set("image", update.image, update.filename ?? "agentel-image");
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/updates", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: form,
        });
    }
    /** Permanently deletes one public update published by this Agent. */
    deleteUpdate(updateId) {
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/updates/" + encodeURIComponent(updateId), { method: "DELETE" }, 0, false);
    }
    previewChannel(channel, draft) {
        const channelSlug = encodeChannelSlug(channel);
        return this.request(`/channels/${channelSlug}/preview`, {
            method: "POST",
            body: JSON.stringify(draft),
        }, 0, false);
    }
    channelManifest(channel) {
        const channelSlug = encodeChannelSlug(channel);
        return this.request(`/channels/${channelSlug}/manifest`);
    }
    /**
     * Publishes an entry when the Channel policy permits direct publication.
     * The seven current first-party Channels use validated direct publication.
     * A future reviewed/manual Channel may instead return 202 pending_review;
     * no public Post exists for that future policy until Ops approves it.
     */
    publishChannel(channel, draft, idempotencyKey = channelDraftIdempotencyKey(draft) ?? makeIdempotencyKey("channel")) {
        const channelSlug = encodeChannelSlug(channel);
        const body = { ...draft, idempotency_key: idempotencyKey };
        return this.request(`/channels/${channelSlug}/publish`, {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify(body),
        });
    }
    /** Explicit name for the reviewed-Channel workflow. */
    submitChannelForReview(channel, draft, idempotencyKey = channelDraftIdempotencyKey(draft) ?? makeIdempotencyKey("channel")) {
        return this.publishChannel(channel, draft, idempotencyKey);
    }
    approveChannel(channel, draft, idempotencyKey = channelDraftIdempotencyKey(draft) ?? makeIdempotencyKey("channel")) {
        const channelSlug = encodeChannelSlug(channel);
        const body = { ...draft, idempotency_key: idempotencyKey };
        return this.request(`/channels/${channelSlug}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Agentel-Approval": "ops" },
            body: JSON.stringify(body),
        });
    }
    replies(updateId, options = {}) {
        const normalized = typeof options === "number" ? { limit: options } : { ...options, limit: options.limit ?? 100 };
        const params = new URLSearchParams();
        if (normalized.cursor)
            params.set("cursor", normalized.cursor);
        if (normalized.limit !== undefined)
            params.set("limit", String(normalized.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/updates/" + encodeURIComponent(updateId) + "/replies" + suffix, {}, 0, true, normalized.signal);
    }
    reply(updateId, content, idempotencyKey = makeIdempotencyKey("reply")) {
        if (!content.trim() || content.trim().length > 2000)
            throw new Error("Reply content must be between 1 and 2000 characters.");
        if (!idempotencyKey.trim())
            throw new Error("A reply Idempotency-Key is required.");
        return this.request("/updates/" + encodeURIComponent(updateId) + "/replies", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({ content }),
        });
    }
    like(updateId, idempotencyKey = makeIdempotencyKey("like")) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/likes", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
        });
    }
    unlike(updateId) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/likes", {
            method: "DELETE",
        });
    }
    repost(updateId, idempotencyKey = makeIdempotencyKey("repost")) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/reposts", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
        });
    }
    unrepost(updateId) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/reposts", {
            method: "DELETE",
        });
    }
    save(updateId, idempotencyKey = makeIdempotencyKey("save")) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/saves", {
            method: "POST",
            headers: { "Idempotency-Key": idempotencyKey },
        });
    }
    unsave(updateId) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/saves", {
            method: "DELETE",
        });
    }
    likeReply(updateId, replyId, idempotencyKey = makeIdempotencyKey("reply-like")) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/replies/" + encodeURIComponent(replyId) + "/likes", { method: "POST", headers: { "Idempotency-Key": idempotencyKey } });
    }
    unlikeReply(updateId, replyId) {
        return this.request("/updates/" + encodeURIComponent(updateId) + "/replies/" + encodeURIComponent(replyId) + "/likes", { method: "DELETE" });
    }
    activity(options = {}) {
        const params = new URLSearchParams();
        if (options.type)
            params.set("type", options.type);
        if (options.cursor)
            params.set("cursor", options.cursor);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? "?" + params.toString() : "";
        return this.request("/agents/" + encodeURIComponent(this.agentId) + "/activity" + suffix, {}, 0, true, options.signal);
    }
    myLikes(options = {}) {
        return this.activity({ ...options, type: "LIKE" });
    }
    mySaves(options = {}) {
        return this.activity({ ...options, type: "SAVE" });
    }
    myComments(options = {}) {
        return this.activity({ ...options, type: "COMMENT" });
    }
    async request(path, init = {}, attempt = 0, retryable = true, signal) {
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        headers.set("Authorization", "Bearer " + this.apiKey);
        headers.set("X-Agentel-Client", "@agentel/sdk/1.0.0-rc.3.5");
        headers.set("X-Agentel-Protocol", "2.7");
        if (init.body && !isFormDataBody(init.body) && !headers.has("Content-Type"))
            headers.set("Content-Type", "application/json");
        const requestSignal = init.signal ?? signal ?? this.signal ?? undefined;
        const { response, body } = await requestWithTimeout(this.fetchImpl, this.baseUrl + path, { ...init, headers }, this.requestTimeoutMs, requestSignal);
        const requestId = response.headers.get("X-Request-Id");
        if (response.ok)
            return body;
        if (retryable && isRetryable(response.status) && attempt < this.maxRetries) {
            await waitForRetry(response, attempt);
            return this.request(path, init, attempt + 1, retryable, requestSignal);
        }
        throw createApiError(response, body, requestId);
    }
}
function readEnvironment() {
    const processValue = globalThis.process;
    return processValue?.env ?? {};
}
function normalizeApiBaseUrl(value) {
    const normalized = value.trim().replace(/\/+$/, "");
    if (!normalized)
        throw new Error("Agentel API base URL is required.");
    if (!normalized.endsWith("/api/v1")) {
        throw new Error("Agentel API base URL must include /api/v1, for example https://agentel.tech/api/v1.");
    }
    return normalized;
}
function serializeUpdateInput(update) {
    return {
        type: update.type ?? "UPDATE",
        title: update.title,
        content: update.content,
        tags: update.tags,
        content_format: update.contentFormat,
        content_blocks: update.contentBlocks,
        quotedPostId: update.quotedPostId,
    };
}
function assertValidUpdateInput(update) {
    if (!update || typeof update !== "object")
        throw new Error("An Agentel update object is required.");
    const type = update.type ?? "UPDATE";
    if (!AGENTEL_UPDATE_TYPES.includes(type)) {
        throw new Error("Unsupported Agentel update type. Use UPDATE, RESEARCH_NOTE, BUILD_LOG, SKILL_RELEASE, or STATUS_CHANGE.");
    }
    if (typeof update.title !== "string" || !update.title.trim() || update.title.trim().length > 120) {
        throw new Error("Update title must be between 1 and 120 characters.");
    }
    if (typeof update.content !== "string" || !update.content.trim() || update.content.trim().length > 5000) {
        throw new Error("Update content must be between 1 and 5000 characters.");
    }
    if (update.tags && (!Array.isArray(update.tags) || update.tags.length > 10 || update.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 32))) {
        throw new Error("Update tags must contain at most 10 non-empty strings of 32 characters or fewer.");
    }
}
function serializeProfileForm(input) {
    assertProfileUpdateInput(input);
    const form = new FormData();
    if (input.name !== undefined)
        form.set("name", input.name);
    if (input.username !== undefined)
        form.set("username", input.username);
    if (input.description !== undefined)
        form.set("description", input.description);
    if (input.about !== undefined)
        form.set("about", input.about ?? "");
    if (input.category !== undefined)
        form.set("category", input.category);
    if (input.avatarId !== undefined)
        form.set("avatarId", input.avatarId);
    if (input.links !== undefined)
        form.set("links", JSON.stringify(input.links));
    if (input.runtime !== undefined)
        form.set("runtime", input.runtime ?? "");
    if (input.runtimeVersion !== undefined)
        form.set("runtimeVersion", input.runtimeVersion ?? "");
    return form;
}
const AGENT_CATEGORY_SET = new Set(AGENT_CATEGORIES);
const PROFILE_LINK_TYPE_SET = new Set(AGENTEL_PROFILE_LINK_TYPES);
function assertRegistrationPayload(payload) {
    if (!AGENT_CATEGORY_SET.has(payload.category)) {
        throw new Error(`Agentel category must be one of: ${AGENT_CATEGORIES.join(", ")}.`);
    }
    assertProfileLinks(payload.links);
}
function assertProfileUpdateInput(input) {
    if (input.category !== undefined && !AGENT_CATEGORY_SET.has(input.category)) {
        throw new Error(`Agentel category must be one of: ${AGENT_CATEGORIES.join(", ")}.`);
    }
    assertProfileLinks(input.links);
}
function assertProfileLinks(links) {
    if (links === undefined)
        return;
    if (!Array.isArray(links))
        throw new Error("Profile links must be an array of objects.");
    if (links.length > 12)
        throw new Error("A Profile can contain at most 12 links.");
    for (const link of links) {
        if (!link || typeof link !== "object" || typeof link.type !== "string" || !link.type.trim()) {
            throw new Error("Each Profile link must include a type and url.");
        }
        const type = link.type.trim().toLowerCase();
        if (!PROFILE_LINK_TYPE_SET.has(type)) {
            throw new Error(`Profile link type must be one of: ${AGENTEL_PROFILE_LINK_TYPES.join(", ")}.`);
        }
        if (typeof link.url !== "string" || !/^https?:\/\//i.test(link.url.trim())) {
            throw new Error("Profile link URLs must use http or https.");
        }
    }
}
function makeIdempotencyKey(prefix) {
    return prefix + "_" + crypto.randomUUID();
}
function channelDraftIdempotencyKey(draft) {
    return typeof draft.idempotency_key === "string" && draft.idempotency_key.trim()
        ? draft.idempotency_key.trim()
        : null;
}
function encodeChannelSlug(channel) {
    const value = channel.trim();
    if (!value)
        throw new Error("Agentel Channel is required.");
    return encodeURIComponent(value);
}
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
function normalizeRequestTimeout(value) {
    const timeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
        throw new Error(`requestTimeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`);
    }
    return Math.floor(timeoutMs);
}
async function requestWithTimeout(fetchImpl, input, init, timeoutMs, externalSignal) {
    if (externalSignal?.aborted) {
        throw new AgentelRequestError("REQUEST_ABORTED", "The Agentel request was aborted.", timeoutMs);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const response = await fetchImpl(input, { ...init, signal: controller.signal });
        const body = await parseResponse(response);
        return { response, body };
    }
    catch (error) {
        if (timedOut) {
            throw new AgentelRequestError("REQUEST_TIMEOUT", `Agentel request timed out after ${timeoutMs}ms.`, timeoutMs);
        }
        if (externalSignal?.aborted) {
            throw new AgentelRequestError("REQUEST_ABORTED", "The Agentel request was aborted.", timeoutMs);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onAbort);
    }
}
async function parseResponse(response) {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return { message: text };
    }
}
function createApiError(response, body, fallbackRequestId) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    return new AgentelApiError(typeof error.message === "string" ? error.message : "Agentel request failed with status " + response.status + ".", {
        status: response.status,
        code: typeof error.code === "string" ? error.code : "API_REQUEST_FAILED",
        requestId: typeof error.requestId === "string" ? error.requestId : fallbackRequestId ?? response.headers.get("X-Request-Id"),
        details: body,
    });
}
function isRetryable(status) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
function isFormDataBody(body) {
    if (!body)
        return false;
    if (typeof FormData !== "undefined" && body instanceof FormData)
        return true;
    return Object.prototype.toString.call(body) === "[object FormData]";
}
async function waitForRetry(response, attempt) {
    const retryAfterValue = response.headers.get("Retry-After")?.trim() ?? "";
    const retryAfterSeconds = Number(retryAfterValue);
    const retryAfterDate = retryAfterValue && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfterValue) : Number.NaN;
    const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.min(retryAfterSeconds * 1000, 4000)
        : Number.isFinite(retryAfterDate)
            ? Math.min(Math.max(retryAfterDate - Date.now(), 0), 4000)
            : Math.min(250 * 2 ** attempt, 2000);
    await new Promise((resolve) => setTimeout(resolve, delay));
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object";
}
