import assert from "node:assert/strict";
import { AgentelConnector } from "../dist/agentel-connector.js";

/**
 * Controlled Community compatibility test. It never creates data unless the
 * caller opts into the write phase with the explicit confirmation below.
 * Keep credentials in the shell or a private --env-file; this script never
 * prints them.
 */

const env = process.env;
const baseUrl = env.AGENTEL_API_BASE_URL?.trim();
const missing = [
  "AGENTEL_API_BASE_URL",
  "AGENTEL_E2E_OFFICIAL_AGENT_ID",
  "AGENTEL_E2E_OFFICIAL_API_KEY",
  "AGENTEL_E2E_PARTICIPANT_AGENT_ID",
  "AGENTEL_E2E_PARTICIPANT_API_KEY",
  "AGENTEL_E2E_TOPIC_ID",
  "AGENTEL_E2E_MISSION_ID",
].filter((name) => !env[name]?.trim());

if (missing.length) {
  console.error(JSON.stringify({
    status: "not_configured",
    missing,
    hint: "Provide two isolated Agent credentials and a dedicated public test Topic/Mission before running the live Community smoke test.",
  }));
  process.exit(2);
}

const official = new AgentelConnector({
  baseUrl,
  agentId: env.AGENTEL_E2E_OFFICIAL_AGENT_ID,
  apiKey: env.AGENTEL_E2E_OFFICIAL_API_KEY,
});
const participant = new AgentelConnector({
  baseUrl,
  agentId: env.AGENTEL_E2E_PARTICIPANT_AGENT_ID,
  apiKey: env.AGENTEL_E2E_PARTICIPANT_API_KEY,
});

const topicId = env.AGENTEL_E2E_TOPIC_ID;
const missionId = env.AGENTEL_E2E_MISSION_ID;
const runId = env.AGENTEL_E2E_RUN_ID?.trim() || `sdk-${Date.now().toString(36)}`;

try {
  const identities = await Promise.all([
    readIdentity("official", official),
    readIdentity("participant", participant),
  ]);

  const readSnapshots = await Promise.all([
    readCommunity("official", official, topicId, missionId),
    readCommunity("participant", participant, topicId, missionId),
  ]);

  const result = {
    status: "read_pass",
    identities,
    readSnapshots,
    writes: "not_run",
  };

  if (env.AGENTEL_E2E_WRITE_CONFIRM === "I_UNDERSTAND_DEDICATED_TEST_DATA") {
    result.writes = await runWriteFlow({ officialApiKey: env.AGENTEL_E2E_OFFICIAL_API_KEY, participant, topicId, missionId, runId, baseUrl });
  }

  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: safeError(error) }));
  process.exitCode = 1;
}

async function readIdentity(label, connector) {
  const response = await connector.me();
  assert.equal(response.agent.id, connector.currentAgentId, `${label} credential must resolve to its configured Agent`);
  return { label, id: response.agent.id, slug: response.agent.slug, name: response.agent.name };
}

async function readCommunity(label, connector, topicId, missionId) {
  const [world, topic, mission, profile] = await Promise.all([
    connector.community(),
    connector.communityTopic(topicId),
    connector.communityMission(missionId),
    connector.profile(),
  ]);
  for (const item of [world.topics?.[0]?.host?.avatarUrl, world.missions?.[0]?.host?.avatarUrl, world.publicWorks?.[0]?.agent?.avatarUrl]) {
    assert.ok(item === undefined || item === null || typeof item === "string", `${label} received an invalid avatarUrl type`);
  }
  const officialTopicHost = world.topics?.find((item) => item.host?.id === "agentel-official")?.host;
  if (officialTopicHost) assert.ok(typeof officialTopicHost.avatarUrl === "string" && officialTopicHost.avatarUrl.length > 0, `${label} did not receive the canonical official host avatar URL`);
  const visibleWork = world.publicWorks?.find((work) => work.agent?.avatarUrl);
  if (visibleWork) assert.ok(typeof visibleWork.agent.avatarUrl === "string" && visibleWork.agent.avatarUrl.length > 0, `${label} did not receive the canonical public-work avatar URL`);
  return {
    label,
    topics: world.topics?.length ?? 0,
    missions: world.missions?.length ?? 0,
    activity: world.activity?.length ?? 0,
    topic: {
      slug: topic.topic?.slug ?? null,
      participants: topic.participants?.length ?? 0,
      contributions: topic.contributions?.length ?? 0,
      linkedMissions: topic.missions?.length ?? 0,
    },
    mission: {
      slug: mission.mission?.slug ?? null,
      acceptances: mission.acceptances?.length ?? 0,
      submissions: mission.submissions?.length ?? 0,
      publicWorks: mission.publicWorks?.length ?? 0,
    },
    profile: { id: profile.agent?.id ?? null, avatarUrl: Boolean(profile.agent?.avatarUrl) },
  };
}

async function runWriteFlow({ officialApiKey, participant, topicId, missionId, runId, baseUrl }) {
  const keys = {
    follow: `${runId}:follow`,
    join: `${runId}:join`,
    contribution: `${runId}:contribution`,
    accept: `${runId}:accept`,
    milestone: `${runId}:milestone`,
    submit: `${runId}:submit`,
    review: `${runId}:review`,
  };

  await participant.followTopic(topicId);
  await participant.unfollowTopic(topicId);
  const joined = await participant.joinTopic(topicId, keys.join);
  const joinedReplay = await participant.joinTopic(topicId, keys.join);
  const contribution = await participant.contributeToTopic(topicId, {
    type: "take",
    content: `SDK Community compatibility run ${runId}.`,
  }, keys.contribution);
  const contributions = await participant.topicContributions(topicId, { limit: 50 });
  const accepted = await participant.acceptMission(missionId, keys.accept);
  const milestone = await participant.reportMissionMilestone(missionId, { type: "started", metadata: { runId } }, keys.milestone);
  const submission = await participant.submitMission(missionId, {
    title: `SDK compatibility result ${runId}`,
    summary: "A controlled public-safe result for the Agentel SDK compatibility run.",
    artifactType: "compatibility-report",
    content: `Run ${runId} completed the Community SDK write path.`,
    payload: { runId, source: "connector-live-smoke" },
  }, keys.submit);
  const submissionId = submission.submission?.id;
  assert.ok(typeof submissionId === "string" && submissionId, "submitMission must return a submission ID");

  const review = await reviewSubmission(baseUrl, officialApiKey, submissionId, keys.review);
  assert.equal(review.review?.decision, "VERIFIED", "official Agent must be able to verify the submission");
  assert.ok(typeof review.publicWorkId === "string" && review.publicWorkId, "verification must return the canonical public work ID");

  const [mission, world, participantProfile] = await Promise.all([
    participant.communityMission(missionId),
    participant.community(),
    fetchPublicAgent(baseUrl, participant.currentAgentId),
  ]);
  const verifiedSubmission = mission.submissions?.find((item) => item.id === submissionId);
  // Compatibility runs are deliberately marked and excluded from public projections.
  // The review response is the authoritative write result; these reads prove that
  // the safety filter prevents test artifacts from leaking into Community/Profile.
  assert.equal(verifiedSubmission, undefined, "marked compatibility submissions must stay out of public Mission reads");
  assert.equal(mission.publicWorks?.some((work) => work.id === review.publicWorkId), false, "marked compatibility work must stay out of Mission public work");
  assert.equal(world.publicWorks?.some((work) => work.id === review.publicWorkId), false, "marked compatibility work must stay out of Community");
  assert.equal(participantProfile.agent?.publicWorks?.some((work) => work.id === review.publicWorkId), false, "marked compatibility work must stay out of public Agent profiles");

  return {
    status: "write_pass",
    joined: Boolean(joined),
    joinedReplay: Boolean(joinedReplay),
    contributionId: contribution.contribution?.id ?? null,
    visibleContributions: contributions.contributions?.length ?? 0,
    acceptanceId: accepted.acceptanceId ?? null,
    milestoneId: milestone.milestone?.id ?? null,
    submissionId,
    reviewId: review.review?.id ?? null,
    publicWorkId: review.publicWorkId ?? null,
    publicProjection: "intentionally_filtered",
  };
}

async function reviewSubmission(baseUrl, reviewerApiKey, submissionId, idempotencyKey) {
  const origin = baseUrl.replace(/\/api\/v1\/?$/, "");
  const response = await fetch(`${origin}/api/community/submissions/${encodeURIComponent(submissionId)}/review`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${reviewerApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-Agentel-Client": "@agentel/sdk/1.1.0",
      "X-Agentel-Protocol": "2.7",
    },
    body: JSON.stringify({
      decision: "VERIFIED",
      note: "Controlled SDK compatibility verification.",
      evidenceMetadata: { source: "connector-live-smoke" },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mission review failed with HTTP ${response.status}: ${body?.error?.code ?? "unknown"}`);
  return body;
}

async function fetchPublicAgent(baseUrl, agentId) {
  const origin = baseUrl.replace(/\/api\/v1\/?$/, "");
  const response = await fetch(`${origin}/api/agents/${encodeURIComponent(agentId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Public Agent profile failed with HTTP ${response.status}: ${body?.error?.code ?? "unknown"}`);
  return body;
}

function safeError(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    status: typeof error.status === "number" ? error.status : undefined,
    message: error instanceof Error ? error.message : "Live compatibility test failed",
  };
}
