import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import test from "node:test";
import { assertArtifactUrl, assertPublicUrl, approveArtifact, extractReadableText, readArtifactApproval, readExternalArtifactIntegrity, readPostedActivity, stripModelTrace } from "../src/run.mjs";

test("the research tool strips executable markup and preserves readable page text", () => {
  const extracted = extractReadableText("<html><head><title>Example &amp; Signal</title><script>alert(1)</script></head><body><h1>Headline</h1><p>Evidence &amp; context.</p></body></html>");
  assert.equal(extracted.title, "Example & Signal");
  assert.match(extracted.text, /Headline Evidence & context\./);
  assert.doesNotMatch(extracted.text, /alert/);
});

test("the research tool rejects loopback and private network sources", () => {
  assert.throws(() => assertPublicUrl("http://127.0.0.1:3000"), /Private network/);
  assert.throws(() => assertPublicUrl("http://localhost:3000"), /Local and private/);
  assert.equal(assertPublicUrl("https://example.com/path").protocol, "https:");
  assert.equal(assertArtifactUrl("https://example.com/artifact.md").protocol, "https:");
  assert.throws(() => assertArtifactUrl("http://example.com/artifact.md"), /HTTPS/);
});

test("the artifact path excludes provider reasoning traces", async () => {
  assert.equal(stripModelTrace("<think>private reasoning</think>\n## Summary\nDone"), "## Summary\nDone");
  assert.equal(stripModelTrace("<analysis>private reasoning</analysis>Report"), "Report");
});

test("artifact approval is bound to the exact hash and required HTTPS public URL", async () => {
  const runDir = await mkdtemp(pathJoin(tmpdir(), "agentel-mastra-approval-"));
  try {
    const artifactText = "# reviewed artifact\n";
    const { createHash } = await import("node:crypto");
    const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
    const report = { runId: "approval-test", status: "artifact_ready", artifact: { sha256: artifactSha256 }, separation: { activity: "not_created" } };
    await writeFile(pathJoin(runDir, "artifact.md"), artifactText, "utf8");
    await assert.rejects(
      () => approveArtifact({ runDir, report, confirmSha256: "0".repeat(64) }),
      /exactly match/
    );
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(artifactText),
      headers: { get: (name) => name === "content-type" ? "text/markdown; charset=utf-8" : null },
    });
    try {
      const approved = await approveArtifact({ runDir, report, confirmSha256: artifactSha256, artifactUrl: "https://example.com/artifact.md" });
      assert.equal(approved.approval.artifactSha256, artifactSha256);
      assert.equal(approved.approval.artifactUrl, "https://example.com/artifact.md");
      const receipt = await readArtifactApproval({ runDir, report, artifactSha256, artifactUrl: "https://example.com/artifact.md" });
      assert.equal(receipt.scope, "publish_activity_only");
      const remote = await readExternalArtifactIntegrity("https://example.com/artifact.md", artifactSha256, "text/markdown");
      assert.equal(remote.sha256, artifactSha256);
      await assert.rejects(
        () => readExternalArtifactIntegrity("https://example.com/artifact.md", "0".repeat(64), "text/markdown"),
        /external artifact content hash/
      );
      await assert.rejects(
        () => readArtifactApproval({ runDir, report, artifactSha256, artifactUrl: null }),
        /URL must be included/
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("activity verification matches the canonical POST resource only", () => {
  assert.equal(readPostedActivity({ activity: [{ type: "POST", resourceType: "POST", resourceId: "update_1" }] }, "update_1"), true);
  assert.equal(readPostedActivity({ activity: [{ type: "COMMENT", resourceType: "POST", resourceId: "update_1" }] }, "update_1"), false);
  assert.equal(readPostedActivity({ activity: [{ type: "POST", resourceType: "POST", resourceId: "update_2" }] }, "update_1"), false);
});

test("reference integration keeps the publication boundary explicit", async () => {
  const source = await readFile(new URL("../src/run.mjs", import.meta.url), "utf8");
  assert.match(source, /creates a Mission submission, Public Work, Verified Work, or Reputation value/);
  assert.match(source, /args\.publishActivity/);
  assert.match(source, /readArtifactApproval/);
  assert.match(source, /--confirm-sha256/);
  assert.match(source, /activity\(\{ type: "POST"/);
});

test("the example package exposes separate run and onboarding commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.run, "node src/run.mjs");
  assert.equal(packageJson.scripts.onboarding, "node scripts/register.mjs");
  assert.equal(packageJson.scripts.preview, "node src/run.mjs --preview");
  assert.equal(packageJson.scripts["approve-artifact"], "node src/run.mjs --approve-artifact");
  assert.equal(packageJson.scripts["publish-activity"], "node src/run.mjs --publish-activity");
});
