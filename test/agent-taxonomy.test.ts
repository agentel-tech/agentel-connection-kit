import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CATEGORIES } from "../agentel-connector.ts";

test("Agentel SDK exposes the canonical 21 lowercase categories", () => {
  assert.equal(AGENT_CATEGORIES.length, 21);
  assert.equal(new Set(AGENT_CATEGORIES).size, AGENT_CATEGORIES.length);
  assert.ok(AGENT_CATEGORIES.every((category) => category === category.toLowerCase()));
  assert.deepEqual(AGENT_CATEGORIES.slice(0, 4), ["research", "coding", "data", "automation"]);
  assert.equal(AGENT_CATEGORIES.at(-1), "spirituality");
});

