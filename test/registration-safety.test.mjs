import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerAndPersist,
  validateRegistrationResult,
} from "../scripts/register-agent.mjs";

const registration = {
  agent: { id: "agent_test_1", slug: "atlas-research" },
  credential: { id: "cred_test_1", key: "agentel_live_test_only" },
  claim: { id: "claim_test_1", code: "claim_test_only", expiresAt: "2030-01-01T00:00:00.000Z" },
};

test("registration safety rejects an idempotent replay without one-time secrets", () => {
  assert.throws(
    () => validateRegistrationResult({
      agent: registration.agent,
      credential: { id: registration.credential.id, key: null, shownOnce: false },
      claim: { id: registration.claim.id, code: null, shownOnce: false },
    }),
    /incomplete credential response/,
  );
});

test("registration safety persists the complete response before /me verification", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentel-register-test-"));
  const calls = [];
  const phases = [];
  const result = await registerAndPersist({
    baseUrl: "https://agentel.test/api/v1",
    idempotencyKey: "install_test_safe_1",
    payload: {
      name: "Atlas Research",
      slug: "atlas-research",
      description: "An evidence-focused research Agent.",
      category: "research",
      avatarId: "icon2",
      installationId: "test-installation-safe-1",
    },
    outputDir,
    onPhase: (phase) => phases.push(phase),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify(registration), { status: 201, headers: { "Content-Type": "application/json", "X-Request-Id": "req_registration_test" } });
      }
      return new Response(JSON.stringify({ agent: { id: registration.agent.id } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(result.meVerified, true);
  assert.deepEqual(phases, ["prepare", "register", "persist", "verify"]);
  assert.equal(calls.length, 2);
  assert.match(await readFile(join(outputDir, ".env"), "utf8"), /AGENTEL_AGENT_ID=agent_test_1/);
  assert.match(await readFile(join(outputDir, "claim-code.env"), "utf8"), /AGENTEL_CLAIM_CODE=claim_test_only/);
  assert.match(await readFile(join(outputDir, "registration-response.json"), "utf8"), /agentel_live_test_only/);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDir, ".env"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(outputDir, "claim-code.env"))).mode & 0o777, 0o600);
  assert.equal(new Headers(calls[0].init.headers).get("Idempotency-Key"), "install_test_safe_1");
  assert.equal(new Headers(calls[1].init.headers).get("Authorization"), "Bearer agentel_live_test_only");
});

test("registration safety requires an explicit slug and installation identity", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentel-register-test-"));
  await assert.rejects(
    () => registerAndPersist({
      baseUrl: "https://agentel.test/api/v1",
      idempotencyKey: "install_test_safe_2",
      payload: { name: "Probe", description: "A test Agent.", category: "research" },
      outputDir,
      fetchImpl: async () => { throw new Error("fetch should not be called"); },
    }),
    /explicit slug/,
  );
});

test("registration safety times out a hanging registration without retrying", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "agentel-register-test-"));
  let calls = 0;
  let aborted = false;

  await assert.rejects(
    () => registerAndPersist({
      baseUrl: "https://agentel.test/api/v1",
      idempotencyKey: "install_test_timeout",
      payload: {
        name: "Timeout Test",
        slug: "timeout-test",
        description: "A timeout safety test.",
        category: "research",
        installationId: "test-installation-timeout",
      },
      outputDir,
      requestTimeoutMs: 20,
      fetchImpl: async (_input, init) => {
        calls += 1;
        await new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
    }),
    /outcome is unknown.*same Idempotency-Key/,
  );

  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.match(await readFile(join(outputDir, "registration-request.json"), "utf8"), /install_test_timeout/);
});
