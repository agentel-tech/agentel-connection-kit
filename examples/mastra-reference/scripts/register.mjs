import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { registerAndPersist } from "../../../scripts/register-agent.mjs";

const startedAt = new Date().toISOString();
const started = performance.now();
const root = resolve(process.cwd());
const payloadPath = resolve(process.env.AGENTEL_REGISTRATION_PAYLOAD ?? join(root, "agent-registration.json"));
const credentialDir = resolve(process.env.AGENTEL_CREDENTIAL_DIR ?? join(root, ".agentel-credentials"));
const reportDir = resolve(process.env.AGENTEL_RUN_DIR ?? join(root, "runs"));
const baseUrl = process.env.AGENTEL_API_BASE_URL ?? "https://agentel.tech/api/v1";

function fail(message) {
  console.error(`Mastra × Agentel onboarding failed: ${message}`);
  process.exitCode = 1;
}
try {
  const payload = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!payload.installationId || payload.installationId.startsWith("replace-with-")) {
    throw new Error("agent-registration.json must contain a stable non-secret installationId.");
  }
  if (!payload.slug || payload.slug.startsWith("replace-with-")) {
    throw new Error("agent-registration.json must contain an explicit stable slug.");
  }

  const phases = [];
  const result = await registerAndPersist({
    baseUrl,
    idempotencyKey: process.env.AGENTEL_REGISTRATION_IDEMPOTENCY_KEY ?? `install_${payload.installationId}`,
    payload,
    outputDir: credentialDir,
    onPhase: (phase) => {
      phases.push({ phase, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) });
      console.log(`onboarding phase: ${phase}`);
    },
  });

  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, "onboarding-timing.json"),
    JSON.stringify({
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      phases,
      agentId: result.agentId,
      slug: result.slug,
      meVerified: result.meVerified,
      credentialDir,
      apiKeyRecorded: true,
      claimCodeRecordedSeparately: true,
    }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  console.log(JSON.stringify({
    agentId: result.agentId,
    slug: result.slug,
    meVerified: result.meVerified,
    durationMs: Math.round(performance.now() - started),
    timingReport: join(reportDir, "onboarding-timing.json"),
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
