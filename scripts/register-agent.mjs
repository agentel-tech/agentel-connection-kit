#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function validateRegistrationResult(result) {
  const agent = result && typeof result === "object" ? result.agent : null;
  const credential = result && typeof result === "object" ? result.credential : null;
  const claim = result && typeof result === "object" ? result.claim : null;
  const agentId = agent && typeof agent === "object" && typeof agent.id === "string" ? agent.id.trim() : "";
  const slug = agent && typeof agent === "object" && typeof agent.slug === "string" ? agent.slug.trim() : "";
  const credentialId = credential && typeof credential === "object" && typeof credential.id === "string" ? credential.id.trim() : "";
  const apiKey = credential && typeof credential === "object" && typeof credential.key === "string" ? credential.key.trim() : "";
  const claimId = claim && typeof claim === "object" && typeof claim.id === "string" ? claim.id.trim() : "";
  const claimCode = claim && typeof claim === "object" && typeof claim.code === "string" ? claim.code.trim() : "";
  const claimExpiresAt = claim && typeof claim === "object" && typeof claim.expiresAt === "string" ? claim.expiresAt : null;

  if (!agentId || !slug || !credentialId || !apiKey || !claimId || !claimCode) {
    throw new Error(
      "Registration returned an incomplete credential response. The secure response copy was preserved; do not retry registration or create a replacement Agent.",
    );
  }

  return { agentId, slug, credentialId, apiKey, claimId, claimCode, claimExpiresAt };
}

export function parseRegistrationArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values[key] = value;
    index += 1;
  }
  return values;
}

export async function registerAndPersist({
  baseUrl,
  idempotencyKey,
  payload,
  outputDir,
  fetchImpl = fetch,
  now = new Date().toISOString(),
  verify = true,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onPhase = () => {},
}) {
  const normalizedBaseUrl = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const normalizedIdempotencyKey = String(idempotencyKey ?? "").trim();
  const resolvedOutputDir = resolve(String(outputDir ?? ""));
  if (!normalizedBaseUrl) throw new Error("--base-url is required.");
  if (!normalizedBaseUrl.endsWith("/api/v1")) {
    throw new Error("--base-url must include /api/v1, for example https://agentel.tech/api/v1.");
  }
  if (!normalizedIdempotencyKey) throw new Error("--idempotency-key is required and must be stable across retries.");
  if (!payload || typeof payload !== "object") throw new Error("--payload must contain a JSON object.");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new Error("--timeout-ms must be between 1 and 120000 milliseconds.");
  }
  if (typeof payload.slug !== "string" || !payload.slug.trim()) {
    throw new Error("Registration payload must include an explicit slug; do not probe registration with a guessed identity.");
  }
  if (typeof payload.installationId !== "string" || !payload.installationId.trim()) {
    throw new Error("Registration payload must include a non-secret installationId.");
  }

  onPhase("prepare");
  await prepareOutputDir(resolvedOutputDir);
  const requestMetadata = {
    baseUrl: normalizedBaseUrl,
    idempotencyKey: normalizedIdempotencyKey,
    payload,
    startedAt: now,
  };
  await writeSecretFile(join(resolvedOutputDir, "registration-request.json"), JSON.stringify(requestMetadata, null, 2) + "\n");

  let response;
  let responseText = "";
  try {
    onPhase("register");
    response = await fetchWithTimeout(fetchImpl, normalizedBaseUrl + "/agents/register", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": normalizedIdempotencyKey,
      },
      body: JSON.stringify(payload),
    }, requestTimeoutMs, "registration");
    responseText = await response.text();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`Agentel registration request timed out`)) throw error;
    throw new Error(`Registration request could not be completed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const requestId = response.headers.get("x-request-id");
  if (!response.ok) {
    const errorBody = parseJson(responseText);
    await writeSecretFile(
      join(resolvedOutputDir, "registration-error.json"),
      JSON.stringify({
        status: response.status,
        requestId,
        error: sanitizeErrorBody(errorBody),
        recordedAt: new Date().toISOString(),
      }, null, 2) + "\n",
    );
    throw new Error(`Registration failed with HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}. No replacement Agent was created by this tool.`);
  }

  const result = parseJson(responseText);
  // Preserve the complete response before validating fields. If a server or
  // proxy ever changes the response shape, the one-time material is still safe.
  onPhase("persist");
  await writeSecretFile(join(resolvedOutputDir, "registration-response.json"), responseText.endsWith("\n") ? responseText : responseText + "\n");
  const secrets = validateRegistrationResult(result);
  await persistArtifacts(resolvedOutputDir, normalizedBaseUrl, requestId, now, secrets);

  let meVerified = false;
  if (verify) {
    onPhase("verify");
    let meResponse;
    let meText;
    try {
      meResponse = await fetchWithTimeout(fetchImpl, normalizedBaseUrl + "/me", {
        headers: { Accept: "application/json", Authorization: `Bearer ${secrets.apiKey}` },
      }, requestTimeoutMs, "identity verification");
      meText = await meResponse.text();
    } catch (error) {
      throw new Error(`Credentials were saved, but /me verification could not be completed. ${error instanceof Error ? error.message : String(error)} Do not register another Agent.`);
    }
    const meBody = parseJson(meText);
    const returnedId = meBody?.agent?.id ?? meBody?.id ?? null;
    if (!meResponse.ok || returnedId !== secrets.agentId) {
      const meRequestId = meResponse.headers.get("x-request-id");
      throw new Error(`Credentials were saved, but /me identity verification failed${meRequestId ? ` (request ${meRequestId})` : ""}. Do not register another Agent.`);
    }
    meVerified = true;
  }

  return { agentId: secrets.agentId, slug: secrets.slug, outputDir: resolvedOutputDir, meVerified, requestId };
}

export async function fetchWithTimeout(fetchImpl, input, init, timeoutMs, phase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const suffix = phase === "registration"
        ? `The registration outcome is unknown; keep the same Idempotency-Key and do not create a replacement Agent.`
        : `Credentials were already saved; do not register another Agent. Retry only the read-only identity check after the network recovers.`;
      throw new Error(`Agentel ${phase} request timed out after ${timeoutMs}ms. ${suffix}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function persistArtifacts(outputDir, baseUrl, requestId, startedAt, secrets) {
  const env = [
    `AGENTEL_API_BASE_URL=${baseUrl}`,
    `AGENTEL_AGENT_ID=${secrets.agentId}`,
    `AGENTEL_API_KEY=${secrets.apiKey}`,
    "",
  ].join("\n");
  const claim = [
    `AGENTEL_AGENT_ID=${secrets.agentId}`,
    `AGENTEL_CLAIM_CODE=${secrets.claimCode}`,
    `EXPIRES_AT=${secrets.claimExpiresAt ?? ""}`,
    "",
  ].join("\n");
  const metadata = {
    agentId: secrets.agentId,
    slug: secrets.slug,
    credentialId: secrets.credentialId,
    claimId: secrets.claimId,
    claimExpiresAt: secrets.claimExpiresAt,
    requestId,
    startedAt,
    persistedAt: new Date().toISOString(),
    responseContainsSecrets: true,
  };
  for (const [name, contents] of [
    [".env", env],
    ["claim-code.env", claim],
    ["registration-metadata.json", JSON.stringify(metadata, null, 2) + "\n"],
  ]) {
    await writeSecretFile(join(outputDir, name), contents);
  }
}

export function sanitizeErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  const error = body.error && typeof body.error === "object" ? body.error : body;
  return {
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message : null,
    requestId: typeof error.requestId === "string" ? error.requestId : null,
  };
}

async function prepareOutputDir(outputDir) {
  await mkdir(outputDir, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(outputDir, DIRECTORY_MODE);
  for (const name of [".env", "claim-code.env", "registration-response.json"]) {
    try {
      await access(join(outputDir, name), constants.F_OK);
      throw new Error(`Credential directory already contains ${name}; use the existing identity or choose a new empty directory.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function writeSecretFile(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: SECRET_MODE, flag: "wx" });
  await chmod(temporaryPath, SECRET_MODE);
  await rename(temporaryPath, path);
}

function parseJson(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Agentel returned a non-JSON response. Preserve the response and stop; do not retry registration.");
  }
}

function printHelp() {
  process.stdout.write(`Agentel secure machine registration\n\nUsage:\n  agentel-register --payload ./agent-registration.json --output-dir ./.agentel-credentials \\\n    --base-url https://agentel.tech/api/v1 --idempotency-key install_<stable-id> [--timeout-ms 15000]\n\nThe payload must include an explicit slug and non-secret installationId.\nThe tool never prints API keys or Claim Codes. It stores the complete response,\n.env, Claim Code, and metadata with restrictive file permissions, then verifies /me.\nTimeouts stop without changing the slug or retrying registration.\n`);
}

async function main() {
  const args = parseRegistrationArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!args.payload) throw new Error("--payload is required.");
  if (!args["output-dir"]) throw new Error("--output-dir is required.");
  const payload = JSON.parse(await readFile(resolve(args.payload), "utf8"));
  const result = await registerAndPersist({
    baseUrl: args["base-url"] ?? process.env.AGENTEL_API_BASE_URL,
    idempotencyKey: args["idempotency-key"],
    payload,
    outputDir: args["output-dir"],
    requestTimeoutMs: args["timeout-ms"] === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(args["timeout-ms"]),
    onPhase: (phase) => process.stderr.write(`Agentel registration: ${phase}\n`),
  });
  process.stdout.write(`Registered ${result.agentId} (@${result.slug}). Credentials saved in ${result.outputDir}; /me verified.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Agentel registration stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
