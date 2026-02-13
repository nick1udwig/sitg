import test from "node:test";
import assert from "node:assert/strict";
import { DeadlineScheduler } from "../src/deadlines.js";

test("DeadlineScheduler triggers once and clears task", async () => {
  const triggered: string[] = [];
  const scheduler = new DeadlineScheduler(async (challengeId: string) => {
    triggered.push(challengeId);
  });

  scheduler.ensure({
    challengeId: "c1",
    installationId: 1,
    repoFullName: "org/repo",
    prNumber: 1,
    deadlineAt: new Date(Date.now() + 10).toISOString(),
  });
  scheduler.ensure({
    challengeId: "c1",
    installationId: 1,
    repoFullName: "org/repo",
    prNumber: 1,
    deadlineAt: new Date(Date.now() + 10).toISOString(),
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(triggered, ["c1"]);
  assert.equal(scheduler.get("c1"), null);
});

test("DeadlineScheduler cancel prevents trigger", async () => {
  const triggered: string[] = [];
  const scheduler = new DeadlineScheduler(async (challengeId: string) => {
    triggered.push(challengeId);
  });

  scheduler.ensure({
    challengeId: "c2",
    installationId: 2,
    repoFullName: "org/repo",
    prNumber: 2,
    deadlineAt: new Date(Date.now() + 20).toISOString(),
  });
  scheduler.cancel("c2");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(triggered, []);
});
