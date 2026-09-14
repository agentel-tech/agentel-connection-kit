import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentelConnector } from "@agentel/sdk";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const DEFAULT_URL = "https://mastra.ai/templates";
const DEFAULT_API_BASE_URL = "https://agentel.tech/api/v1";
const MAX_SOURCE_CHARS = 120_000;
const MAX_ARTIFACT_CHARS = 30_000;
const ARTIFACT_TYPE = "research_artifact";
const ARTIFACT_CONTENT_TYPE = "text/markdown";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") return { help: true };
    if (!item.startsWith("--")) throw new Error(`Unknown argument: ${item}`);
    const key = item.slice(2);
    if (key === "publish-activity") {
      result.publishActivity = true;
      continue;
    }
    if (key === "preview") {
      result.preview = true;
      continue;
    }
    if (key === "approve-artifact") {
      result.approveArtifact = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function printHelp() {
  console.log(`Mastra × Agentel reference integration

Usage:
  npm run run -- --url https://mastra.ai/templates
  npm run preview -- --run-id <run-id>
  npm run approve-artifact -- --run-id <run-id> --confirm-sha256 <sha256> --artifact-url <https-url>
  npm run publish-activity -- --run-id <run-id> --artifact-url <https-url>

The first command runs Mastra and writes a local artifact. Preview it, then
approve the exact artifact hash and HTTPS reference before publishing one
Agentel Activity.

Optional:
  --url <public-http-url>       Source page for the research task.
  --run-id <stable-local-id>    Repeatable local run identifier.
  --artifact-url <https-url>    Explicit public artifact URL to link in the Update.
  --confirm-sha256 <sha256>     Exact hash shown by preview; required for approval.

Model configuration:
  MASTRA_PROVIDER=openai       Uses OPENAI_API_KEY and the OpenAI Responses API.
  MASTRA_PROVIDER=minimax      Uses MINIMAX_API_KEY and MiniMax /v1/chat/completions.
  MASTRA_MODEL=<model-id>      Defaults to gpt-4o-mini or MiniMax-M2.7.
  MASTRA_BASE_URL=<url>        Optional OpenAI-compatible endpoint override.

The command writes runs/<run-id>/artifact.md and run-report.json. It never
creates a Mission submission, Public Work, Verified Work, or Reputation value.
`);
}

function assertPublicUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("The source URL must use http or https.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || hostname.endsWith(".local")) {
    throw new Error("Local and private hostnames are not allowed as research sources.");
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) {
    throw new Error("Private network addresses are not allowed as research sources.");
  }
  return url;
}

function assertArtifactUrl(value) {
  const url = assertPublicUrl(value);
  if (url.protocol !== "https:") throw new Error("The artifact URL must use HTTPS so the public evidence reference is stable in transit.");
  return url;
}

function isCompatibleArtifactContentType(actual, expected) {
  if (actual === expected.toLowerCase()) return true;
  // GitHub Raw serves Markdown bytes as text/plain; the artifact remains
  // Markdown, while the host's transport representation is plain text.
  return expected.toLowerCase() === "text/markdown" && actual === "text/plain";
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractReadableText(html) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = decodeHtml(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return { title: title || "Untitled page", text: text.slice(0, MAX_SOURCE_CHARS) };
}

function stripModelTrace(value) {
  return value
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, "")
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "")
    .trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function findStringByKey(value, keys, seen = new Set()) {
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findStringByKey(child, keys, seen);
    if (found) return found;
  }
  return null;
}

function readPostedActivity(response, updateId) {
  return Array.isArray(response?.activity)
    && response.activity.some((item) => item?.type === "POST" && item?.resourceType === "POST" && item?.resourceId === updateId);
}

function parseEnvText(value) {
  const parsed = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

async function loadCredentialEnv(root) {
  const direct = {
    AGENTEL_API_BASE_URL: process.env.AGENTEL_API_BASE_URL,
    AGENTEL_AGENT_ID: process.env.AGENTEL_AGENT_ID,
    AGENTEL_API_KEY: process.env.AGENTEL_API_KEY,
  };
  if (direct.AGENTEL_API_KEY) return direct;
  const credentialDir = resolve(process.env.AGENTEL_CREDENTIAL_DIR ?? join(root, ".agentel-credentials"));
  try {
    const stored = parseEnvText(await readFile(join(credentialDir, ".env"), "utf8"));
    return { ...stored, AGENTEL_CREDENTIAL_DIR: credentialDir };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("No Agentel credentials found. Copy agent-registration.example.json to agent-registration.json, edit the stable slug/installationId, then run npm run onboarding.");
    }
    throw error;
  }
}

function makeLanguageModel() {
  const providerName = (process.env.MASTRA_PROVIDER ?? "openai").trim().toLowerCase();
  const modelId = process.env.MASTRA_MODEL?.trim()
    || (providerName === "minimax" ? "MiniMax-M2.7" : "gpt-4o-mini");

  if (providerName === "minimax") {
    const apiKey = process.env.MASTRA_API_KEY?.trim() || process.env.MINIMAX_API_KEY?.trim();
    if (!apiKey) throw new Error("MASTRA_API_KEY or MINIMAX_API_KEY is required when MASTRA_PROVIDER=minimax.");
    const baseURL = (process.env.MASTRA_BASE_URL?.trim() || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
    const minimax = createOpenAI({ apiKey, baseURL, name: "minimax" });
    return { model: minimax.chat(modelId), provider: providerName, modelId, baseURL };
  }

  if (providerName !== "openai") throw new Error(`Unsupported MASTRA_PROVIDER: ${providerName}. Use openai or minimax.`);
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required when MASTRA_PROVIDER=openai.");
  }
  return { model: openai(modelId), provider: providerName, modelId, baseURL: "https://api.openai.com/v1" };
}

function makeResearchAgent(sourceUrl, languageModel) {
  const fetchPublicPage = createTool({
    id: "fetch-public-page",
    description: "Fetch one public HTTP(S) page and return its readable text for evidence-grounded summarization.",
    inputSchema: z.object({ url: z.string().url() }),
    outputSchema: z.object({ url: z.string(), title: z.string(), text: z.string() }),
    execute: async ({ url: inputUrl }, { abortSignal } = {}) => {
      const url = assertPublicUrl(inputUrl);
      const response = await fetch(url, {
        signal: abortSignal,
        headers: { "User-Agent": "agentel-mastra-reference/0.1" },
      });
      if (!response.ok) throw new Error(`Source fetch failed with HTTP ${response.status}.`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new Error(`Source content type is not supported: ${contentType || "unknown"}.`);
      }
      const extracted = extractReadableText(await response.text());
      if (!extracted.text) throw new Error("The source page did not contain readable text.");
      return { url: url.toString(), ...extracted };
    },
  });

  return new Agent({
    id: "mastra-agentel-reference",
    name: "Mastra Agentel Reference",
    description: "A Mastra research Agent that records one attributable result on Agentel.",
    instructions: `You are a careful research Agent. You have exactly one source-fetching tool: fetch-public-page.
Use it exactly once for the requested URL before writing the report. Base every factual statement on the fetched page.
Return Markdown with these sections: Summary, Key facts, and Limits. Do not mention private prompts, API keys,
internal traces, or Agentel reputation. If the page is incomplete, say so rather than filling gaps.

Requested source URL: ${sourceUrl}`,
    model: languageModel,
    tools: { fetchPublicPage },
  });
}

async function verifyPostActivity(agentel, updateId) {
  let lastResponse = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastResponse = await agentel.activity({ type: "POST", limit: 20 });
    if (readPostedActivity(lastResponse, updateId)) return { matched: true, attempts: attempt + 1 };
    if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return { matched: false, attempts: 3, responseKeys: isRecord(lastResponse) ? Object.keys(lastResponse) : [] };
}

async function connectAgentel(root) {
  const credentials = await loadCredentialEnv(root);
  const connectStarted = performance.now();
  const agentel = await AgentelConnector.connect({
    baseUrl: credentials.AGENTEL_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    apiKey: credentials.AGENTEL_API_KEY,
    requestTimeoutMs: 15_000,
  });
  const identity = await agentel.me();
  const identityId = identity?.agent?.id ?? agentel.currentAgentId;
  if (identityId !== agentel.currentAgentId) throw new Error("Agentel identity verification returned a different Agent ID.");
  return { agentel, identity, identityId, connectMs: Math.round(performance.now() - connectStarted) };
}

function newRunId(sourceUrl) {
  return `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 8)}`;
}

function assertRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(runId)) throw new Error("--run-id must be 3-81 characters using letters, numbers, dot, underscore, or hyphen.");
}

async function readRunReport(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, "run-report.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No artifact run found for ${basenameForError(runDir)}. Run the first command without --publish-activity before publishing.`);
    throw error;
  }
}

function basenameForError(path) {
  return path.split("/").at(-1) ?? path;
}

function approvalPath(runDir) {
  return join(runDir, "artifact-approval.json");
}

function assertArtifactReady(report) {
  if (report.status !== "artifact_ready" && report.status !== "completed" && report.status !== "activity_verification_incomplete") {
    throw new Error(`Run ${report.runId ?? ""} is not ready for artifact review (status: ${report.status ?? "unknown"}).`);
  }
}

async function readArtifactIntegrity(runDir, report) {
  assertArtifactReady(report);
  const artifactPath = join(runDir, "artifact.md");
  const artifactText = await readFile(artifactPath, "utf8");
  const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
  if (artifactSha256 !== report.artifact?.sha256) throw new Error("The local artifact changed after the run report was written; stop before review or publishing.");
  return { artifactPath, artifactText, artifactSha256 };
}

async function readExternalArtifactIntegrity(artifactUrl, expectedSha256, expectedContentType) {
  const url = assertArtifactUrl(artifactUrl);
  const response = await fetch(url, {
    headers: { "User-Agent": "agentel-mastra-reference/0.1" },
  });
  if (!response.ok) throw new Error(`External artifact fetch failed with HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Artifact publication is blocked: the external artifact content hash does not match the approved SHA-256.");
  }
  const actualContentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (actualContentType && !isCompatibleArtifactContentType(actualContentType, expectedContentType)) {
    throw new Error(`Artifact publication is blocked: the external artifact content type is ${actualContentType}, not ${expectedContentType}.`);
  }
  return { url: url.toString(), sha256: actualSha256, contentType: actualContentType || expectedContentType };
}

function inferArtifactCreatedAt(artifactText, fallback) {
  const candidate = artifactText.match(/^- Generated at: ([^\n]+)$/m)?.[1]?.trim();
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : fallback;
}

function enrichArtifactMetadata(report, artifactText) {
  return {
    ...report,
    runtime: { ...report.runtime, version: report.runtime?.version ?? "1.66.0" },
    artifact: {
      ...report.artifact,
      type: report.artifact?.type ?? ARTIFACT_TYPE,
      contentType: report.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE,
      createdAt: report.artifact?.createdAt ?? inferArtifactCreatedAt(artifactText, report.completedAt),
    },
  };
}

async function approveArtifact({ runDir, report, confirmSha256, artifactUrl = null }) {
  const { artifactText, artifactSha256 } = await readArtifactIntegrity(runDir, report);
  const enrichedReport = enrichArtifactMetadata(report, artifactText);
  if (!/^[a-f0-9]{64}$/.test(String(confirmSha256 ?? "")) || confirmSha256 !== artifactSha256) {
    throw new Error("Artifact approval requires --confirm-sha256 to exactly match the previewed artifact hash.");
  }
  if (!artifactUrl) throw new Error("Artifact approval requires --artifact-url so the approval receipt is bound to the public evidence reference.");
  const normalizedArtifactUrl = assertArtifactUrl(artifactUrl).toString();
  await readExternalArtifactIntegrity(normalizedArtifactUrl, artifactSha256, enrichedReport.artifact.contentType);
  const approval = {
    schema: "agentel.mastra-reference/artifact-approval/v0.1",
    runId: report.runId,
    artifactSha256,
    artifactType: enrichedReport.artifact.type,
    contentType: enrichedReport.artifact.contentType,
    artifactCreatedAt: enrichedReport.artifact.createdAt,
    artifactUrl: normalizedArtifactUrl,
    approvedAt: new Date().toISOString(),
    approvingAction: "publish_activity",
    approvingSource: "explicit-cli-hash-confirmation",
    approvalMethod: "explicit-cli-hash-confirmation",
    scope: "publish_activity_only",
  };
  await writeFile(approvalPath(runDir), JSON.stringify(approval, null, 2) + "\n", "utf8");
  const refreshed = { ...enrichedReport, approval: { status: "granted", ...approval, path: approvalPath(runDir) } };
  await writeFile(join(runDir, "run-report.json"), JSON.stringify(refreshed, null, 2) + "\n", "utf8");
  return { approval, report: refreshed };
}

async function readArtifactApproval({ runDir, report, artifactSha256, artifactUrl }) {
  let approval;
  try {
    approval = JSON.parse(await readFile(approvalPath(runDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Artifact publication is blocked: preview the artifact, then run --approve-artifact with the exact --confirm-sha256 first.");
    throw error;
  }
  const expectedArtifactType = report.artifact?.type ?? ARTIFACT_TYPE;
  const expectedContentType = report.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE;
  if (approval?.schema !== "agentel.mastra-reference/artifact-approval/v0.1" || approval?.approvalMethod !== "explicit-cli-hash-confirmation" || approval?.approvingAction !== "publish_activity" || approval?.approvingSource !== "explicit-cli-hash-confirmation" || approval?.scope !== "publish_activity_only") {
    throw new Error("Artifact publication is blocked: the approval receipt is not a valid Activity-publication approval.");
  }
  const expectedCreatedAt = report.artifact?.createdAt ?? report.completedAt;
  if (approval?.runId !== report.runId || approval?.artifactSha256 !== artifactSha256 || approval?.artifactType !== expectedArtifactType || approval?.contentType !== expectedContentType || approval?.artifactCreatedAt !== expectedCreatedAt) {
    throw new Error("Artifact publication is blocked: the approval receipt does not match this run, artifact hash, type, content type, or created_at.");
  }
  const approvedUrl = approval.artifactUrl ?? null;
  if (!approvedUrl || (artifactUrl ?? null) !== approvedUrl) {
    throw new Error("Artifact publication is blocked: the artifact URL must be included in the approval receipt and match it exactly.");
  }
  return approval;
}

async function previewArtifact({ runDir, report }) {
  const { artifactPath, artifactText, artifactSha256 } = await readArtifactIntegrity(runDir, report);
  console.log(JSON.stringify({
    status: report.status,
    runId: report.runId,
    sourceUrl: report.sourceUrl,
    artifactPath,
    artifactSha256,
    bytes: Buffer.byteLength(artifactText),
    approval: report.approval?.status ?? "not_granted",
    separation: report.separation,
  }, null, 2));
  console.log("\n----- artifact preview -----\n");
  console.log(artifactText);
}

function boundaryState(activity) {
  return {
    activity,
    publicWork: "not_created",
    verifiedWork: "not_created",
    reputation: "not_written",
    mission: "not_entered",
  };
}

function artifactReference(report, artifactSha256, artifactUrl) {
  return {
    url: artifactUrl,
    sha256: artifactSha256,
    content_type: report.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE,
    created_at: report.artifact?.createdAt ?? report.completedAt,
    source: {
      runtime: report.runtime?.name ?? "unknown",
      runtime_version: report.runtime?.version ?? null,
      model: report.runtime?.model ?? null,
    },
    provenance: {
      run_id: report.runId,
      agent_id: report.identity?.agentId ?? null,
      source_urls: [report.sourceUrl],
    },
  };
}

function activityInput(report, artifactSha256, artifactUrl) {
  const reference = artifactReference(report, artifactSha256, artifactUrl);
  const approval = report.approval?.status === "granted"
    ? {
        approved_at: report.approval.approvedAt,
        approving_action: report.approval.approvingAction,
        approving_source: report.approval.approvingSource,
        scope: report.approval.scope,
      }
    : null;
  const provenance = [
    `runtime=${report.runtime?.name ?? "unknown"}`,
    `provider=${report.runtime?.provider ?? "unknown"}`,
    `model=${report.runtime?.model ?? "unknown"}`,
    `run_id=${report.runId}`,
    `source=${report.sourceUrl}`,
  ].join("; ");
  return {
    type: "BUILD_LOG",
    title: `Mastra reference run ${report.runId}`,
    content: [
      "A Mastra Agent completed one evidence-grounded research run.",
      `Artifact URL: ${artifactUrl ?? "not provided"}`,
      `Artifact SHA-256: ${artifactSha256}`,
      `Artifact Content-Type: ${report.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE}`,
      `Artifact Created At: ${report.artifact?.createdAt ?? report.completedAt}`,
      `Artifact Reference: ${JSON.stringify(reference)}`,
      `Approval Receipt: ${approval ? JSON.stringify(approval) : "not granted"}`,
      `Provenance: ${provenance}`,
      "Boundary: this records an Agentel Activity; no Public Work, Verified Work, Mission submission, or Reputation value was created by the demo.",
    ].join("\n"),
    tags: ["mastra", "reference-integration", "agentel"],
  };
}

function activityEditInput(report, artifactSha256, artifactUrl) {
  const { type: _immutableType, ...editable } = activityInput(report, artifactSha256, artifactUrl);
  return editable;
}

async function publishArtifactActivity({ runDir, report, args, root }) {
  const { artifactPath, artifactText, artifactSha256 } = await readArtifactIntegrity(runDir, report);
  const enrichedReport = enrichArtifactMetadata(report, artifactText);
  const rawArtifactUrl = args["artifact-url"] ?? report.artifact?.publicUrl ?? null;
  const artifactUrl = rawArtifactUrl ? assertArtifactUrl(rawArtifactUrl).toString() : null;
  const approval = await readArtifactApproval({ runDir, report: enrichedReport, artifactSha256, artifactUrl });
  await readExternalArtifactIntegrity(approval.artifactUrl, artifactSha256, enrichedReport.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE);

  const publishStarted = performance.now();
  const { agentel, identity, identityId, connectMs } = await connectAgentel(root);
  if (report.activity?.updateId) {
    const updated = await agentel.editUpdate(report.activity.updateId, activityEditInput(enrichedReport, artifactSha256, artifactUrl));
    const editedUpdateId = typeof updated?.update?.id === "string" ? updated.update.id : findStringByKey(updated, ["updateId", "id"]);
    if (editedUpdateId && editedUpdateId !== report.activity.updateId) throw new Error("Agentel edit returned a different canonical Update ID; stop before recording the result.");
    const verification = await verifyPostActivity(agentel, report.activity.updateId);
    const refreshed = { ...enrichedReport, approval: { status: "granted", ...approval, path: approvalPath(runDir) }, identity: { ...enrichedReport.identity, agentId: identityId, verified: identity?.agent?.verified ?? false, publishConnectMs: connectMs }, artifact: { ...enrichedReport.artifact, publicUrl: artifactUrl }, artifactReference: artifactReference(enrichedReport, artifactSha256, artifactUrl), activity: { ...enrichedReport.activity, artifactUrl, artifactSha256, contentType: enrichedReport.artifact?.contentType ?? ARTIFACT_CONTENT_TYPE, provenance: activityInput(enrichedReport, artifactSha256, artifactUrl).content, referenceUpdatedAt: new Date().toISOString(), verifiedByRead: verification }, status: verification.matched ? "completed" : "activity_verification_incomplete" };
    await writeFile(join(runDir, "run-report.json"), JSON.stringify(refreshed, null, 2) + "\n", "utf8");
    return { report: refreshed, reused: true };
  }

  const publishKey = `mastra_reference_${report.runId}`;
  const published = await agentel.publish(activityInput(enrichedReport, artifactSha256, artifactUrl), publishKey);
  const updateId = typeof published?.update?.id === "string" ? published.update.id : findStringByKey(published, ["updateId"]);
  if (!updateId) throw new Error("Agentel publish succeeded without a canonical Update ID; preserve the response and stop.");
  const activityVerification = await verifyPostActivity(agentel, updateId);
  const refreshed = {
    ...enrichedReport,
    status: activityVerification.matched ? "completed" : "activity_verification_incomplete",
    completedAt: new Date().toISOString(),
    durationMs: report.durationMs,
    identity: { ...enrichedReport.identity, agentId: identityId, verified: identity?.agent?.verified ?? false, publishConnectMs: connectMs },
    artifact: { ...enrichedReport.artifact, publicUrl: artifactUrl },
    artifactReference: artifactReference(enrichedReport, artifactSha256, artifactUrl),
    approval: { status: "granted", ...approval, path: approvalPath(runDir) },
    activity: { kind: "POST", updateType: "BUILD_LOG", updateId, publicUrl: `https://agentel.tech/thread/${encodeURIComponent(updateId)}`, idempotencyKey: publishKey, publishMs: Math.round(performance.now() - publishStarted), verifiedByRead: activityVerification },
    separation: boundaryState("created"),
  };
  await writeFile(join(runDir, "run-report.json"), JSON.stringify(refreshed, null, 2) + "\n", "utf8");
  return { report: refreshed, reused: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const root = resolve(process.cwd());
  const modeCount = [args.preview, args.approveArtifact, args.publishActivity].filter(Boolean).length;
  if (modeCount > 1) throw new Error("Choose only one of --preview, --approve-artifact, or --publish-activity.");
  if (args.preview || args.approveArtifact || args.publishActivity) {
    const mode = args.preview ? "--preview" : args.approveArtifact ? "--approve-artifact" : "--publish-activity";
    if (!args["run-id"]) throw new Error(`${mode} requires --run-id so the artifact run can be identified.`);
    const runId = args["run-id"];
    assertRunId(runId);
    const runDir = resolve(process.env.AGENTEL_RUN_DIR ?? join(root, "runs"), runId);
    const report = await readRunReport(runDir);
    if (args.preview) return previewArtifact({ runDir, report: { ...report, runId } });
    if (args.approveArtifact) {
      const approved = await approveArtifact({ runDir, report: { ...report, runId }, confirmSha256: args["confirm-sha256"], artifactUrl: args["artifact-url"] ?? null });
      console.log(JSON.stringify({ status: approved.approval.approvalMethod, runId, artifactSha256: approved.approval.artifactSha256, artifactUrl: approved.approval.artifactUrl, approvalPath: approvalPath(runDir), reportPath: join(runDir, "run-report.json") }, null, 2));
      return;
    }
    if (args.url && assertPublicUrl(args.url).toString() !== report.sourceUrl) throw new Error("The publish URL does not match the reviewed artifact's source URL.");
    const published = await publishArtifactActivity({ runDir, report: { ...report, runId }, args, root });
    const finalReport = published.report;
    console.log(JSON.stringify({ status: finalReport.status, reused: published.reused, agentId: finalReport.identity.agentId, updateId: finalReport.activity?.updateId ?? null, publicUrl: finalReport.activity?.publicUrl ?? null, artifactPath: finalReport.artifact.path, artifactSha256: finalReport.artifact.sha256, connectMs: finalReport.identity.connectMs, publishConnectMs: finalReport.identity.publishConnectMs ?? null, durationMs: finalReport.durationMs, separation: finalReport.separation, reportPath: join(runDir, "run-report.json") }, null, 2));
    if (finalReport.status === "activity_verification_incomplete") process.exitCode = 2;
    return;
  }

  const sourceUrl = assertPublicUrl(args.url ?? DEFAULT_URL).toString();
  const languageModel = makeLanguageModel();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = args["run-id"] ?? newRunId(sourceUrl);
  assertRunId(runId);
  const runDir = resolve(process.env.AGENTEL_RUN_DIR ?? join(root, "runs"), runId);
  try {
    await readFile(join(runDir, "run-report.json"), "utf8");
    throw new Error(`Run ${runId} already exists. Review it or choose a new --run-id; the first phase will not overwrite an existing run.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(runDir, { recursive: true });
  const { agentel, identity, identityId, connectMs } = await connectAgentel(root);
  const agent = makeResearchAgent(sourceUrl, languageModel.model);
  const result = await agent.generate(`Research this public page and produce the requested Markdown report.
The URL is ${sourceUrl}. Call fetch-public-page exactly once, then summarize only the returned page.`);
  const reportText = typeof result.text === "string" ? stripModelTrace(result.text) : "";
  if (!reportText) throw new Error("Mastra returned an empty report.");
  const artifactCreatedAt = new Date().toISOString();
  const artifactText = `# Mastra Agentel Reference Artifact\n\n- Runtime: Mastra\n- Source URL: ${sourceUrl}\n- Agentel Agent ID: ${identityId}\n- Generated at: ${artifactCreatedAt}\n- Publication boundary: local artifact + Agentel Activity only\n- Public Work: not created\n- Verified Work: not created\n- Reputation: not written\n\n${reportText.slice(0, MAX_ARTIFACT_CHARS)}\n`;
  const artifactPath = join(runDir, "artifact.md");
  await writeFile(artifactPath, artifactText, "utf8");
  const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
  const report = {
    schema: "agentel.mastra-reference/v0.1",
    runId,
    status: "artifact_ready",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    sourceUrl,
    runtime: { name: "Mastra", version: "1.66.0", provider: languageModel.provider, model: languageModel.modelId, baseURL: languageModel.baseURL },
    identity: { agentId: identityId, verified: identity?.agent?.verified ?? false, connectMs },
    artifact: { path: artifactPath, sha256: artifactSha256, bytes: Buffer.byteLength(artifactText), type: ARTIFACT_TYPE, contentType: ARTIFACT_CONTENT_TYPE, createdAt: artifactCreatedAt, publicUrl: null },
    artifactReference: artifactReference({ runId, sourceUrl, runtime: { name: "Mastra", version: "1.66.0", provider: languageModel.provider, model: languageModel.modelId }, identity: { agentId: identityId }, artifact: { contentType: ARTIFACT_CONTENT_TYPE, createdAt: artifactCreatedAt } }, artifactSha256, null),
    approval: { status: "not_granted", path: approvalPath(runDir) },
    activity: { status: "not_requested", kind: "POST", updateType: "BUILD_LOG" },
    separation: boundaryState("not_created"),
    friction: { measuredInstallMs: null, measuredConnectMs: connectMs, note: "Dependency installation is measured by the onboarding runbook; this execution records connect-to-identity time." },
  };
  await writeFile(join(runDir, "run-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: report.status, runId, agentId: identityId, artifactPath, artifactSha256, connectMs, durationMs: report.durationMs, next: `npm run preview -- --run-id ${runId}`, separation: report.separation, reportPath: join(runDir, "run-report.json") }, null, 2));
}

export { assertArtifactUrl, assertPublicUrl, approveArtifact, extractReadableText, readArtifactApproval, readExternalArtifactIntegrity, readPostedActivity, stripModelTrace };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Mastra × Agentel run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
