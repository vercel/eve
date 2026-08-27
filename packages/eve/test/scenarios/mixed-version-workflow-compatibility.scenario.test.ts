import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MessageStreamEvent } from "#protocol/message.js";
import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";
import {
  buildMixedVersionWorkflowDeployment,
  createPromotableWorkflowWorld,
  materializeMixedVersionWorkflowApp,
  type PromotableWorkflowWorld,
} from "../helpers/mixed-version-workflow.js";

const AGENT_NAME = "mixed-version-workflow";
const HISTORICAL_DEPLOYMENT_ID = "historical-eve-0-30-8";
const CANDIDATE_DEPLOYMENT_ID = "candidate-current";
const WORKFLOW_ENTRY_ID = "workflow//eve//workflowEntry";
const TURN_WORKFLOW_ID = "workflow//eve//turnWorkflow";
const SCENARIO_TIMEOUT_MS = 360_000;

const APP_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": [
      'import { defineAgent } from "eve";',
      "",
      "export default defineAgent({",
      '  model: "openai/gpt-5.4-mini",',
      "});",
      "",
    ].join("\n"),
    "agent/instructions.md": "Reply briefly to each message.\n",
  },
  name: AGENT_NAME,
};

describe("mixed-version Workflow compatibility", () => {
  it(
    "keeps the 0.30.8 driver pinned while the promoted candidate owns the next turn",
    async () => {
      const apps: Array<Awaited<ReturnType<typeof materializeMixedVersionWorkflowApp>>> = [];
      let workflowWorld: PromotableWorkflowWorld | undefined;
      const previousVercelEnvironment = process.env.VERCEL_ENV;

      try {
        const historicalApp = await materializeMixedVersionWorkflowApp({
          descriptor: APP_DESCRIPTOR,
          eveVersion: "0.30.8",
        });
        apps.push(historicalApp);
        const candidateApp = await materializeMixedVersionWorkflowApp({
          descriptor: APP_DESCRIPTOR,
          eveVersion: "current",
        });
        apps.push(candidateApp);

        const [historical, candidate] = await Promise.all([
          buildMixedVersionWorkflowDeployment({
            agentName: AGENT_NAME,
            appRoot: historicalApp.appRoot,
            deploymentId: HISTORICAL_DEPLOYMENT_ID,
            eveVersion: "0.30.8",
          }),
          buildMixedVersionWorkflowDeployment({
            agentName: AGENT_NAME,
            appRoot: candidateApp.appRoot,
            deploymentId: CANDIDATE_DEPLOYMENT_ID,
            eveVersion: "current",
          }),
        ]);
        workflowWorld = await createPromotableWorkflowWorld({
          agentName: AGENT_NAME,
          dataDir: join(candidateApp.appRoot, ".eve", "mixed-version-world"),
          deployments: [historical, candidate],
          initialDeploymentId: HISTORICAL_DEPLOYMENT_ID,
        });
        await workflowWorld.start();
        const world = workflowWorld.world;
        process.env.VERCEL_ENV = "production";

        const historicalRuntime = await historical.createRuntime();
        const session = await workflowWorld.runInDeployment(HISTORICAL_DEPLOYMENT_ID, async () =>
          historicalRuntime.createSession({
            adapter: { kind: "http" },
            auth: null,
            input: { message: "First historical turn." },
            mode: "conversation",
          }),
        );
        const firstEvents = await workflowWorld.runInDeployment(
          HISTORICAL_DEPLOYMENT_ID,
          async () => await readUntilWaiting(session.events),
        );
        expect(firstEvents.map((event) => event.type)).not.toContain("turn.failed");
        expect(firstEvents.map((event) => event.type)).not.toContain("session.failed");

        const driverBeforePromotion = await world.runs.get(session.sessionId, {
          resolveData: "none",
        });
        expect(driverBeforePromotion).toMatchObject({
          deploymentId: HISTORICAL_DEPLOYMENT_ID,
          status: "running",
          workflowName: WORKFLOW_ENTRY_ID,
        });

        const deliveryCountBeforePromotion = workflowWorld.deliveries.length;
        workflowWorld.promote(CANDIDATE_DEPLOYMENT_ID);
        const followUpStartIndex = firstEvents.length;
        await expect(
          workflowWorld.runInDeployment(HISTORICAL_DEPLOYMENT_ID, async () =>
            historicalRuntime.dispatchSession({
              command: { kind: "send", payload: { message: "Compatible follow-up." } },
              sessionId: session.sessionId,
            }),
          ),
        ).resolves.toEqual({ sessionId: session.sessionId, status: "accepted" });
        const followUpEvents = await workflowWorld.runInDeployment(
          HISTORICAL_DEPLOYMENT_ID,
          async () =>
            await readUntilWaiting(
              await historicalRuntime.getEventStream(session.sessionId, {
                startIndex: followUpStartIndex,
              }),
            ),
        );

        const driverAfterPromotion = await world.runs.get(session.sessionId, {
          resolveData: "none",
        });
        expect(driverAfterPromotion).toMatchObject({
          deploymentId: HISTORICAL_DEPLOYMENT_ID,
          status: "running",
          workflowName: WORKFLOW_ENTRY_ID,
        });

        const turnRuns = await world.runs.list({
          pagination: { limit: 100 },
          resolveData: "none",
          workflowName: TURN_WORKFLOW_ID,
        });
        expect(turnRuns.data).toHaveLength(2);
        const settledTurnRuns = await Promise.all(
          turnRuns.data.map(async (run) => await waitForRunToSettle(world, run.runId)),
        );
        expect(settledTurnRuns.map((run) => run.status)).toEqual(["completed", "completed"]);
        expect(turnRuns.data.map((run) => run.deploymentId).sort()).toEqual(
          [HISTORICAL_DEPLOYMENT_ID, CANDIDATE_DEPLOYMENT_ID].sort(),
        );
        const candidateTurn = turnRuns.data.find(
          (run) => run.deploymentId === CANDIDATE_DEPLOYMENT_ID,
        );
        expect(candidateTurn).toBeDefined();
        const followUpDeliveries = workflowWorld.deliveries.slice(deliveryCountBeforePromotion);
        expect(
          followUpDeliveries.some(
            (delivery) =>
              delivery.runId === candidateTurn?.runId &&
              delivery.deploymentId === CANDIDATE_DEPLOYMENT_ID,
          ),
        ).toBe(true);
        expect(followUpDeliveries).toContainEqual({
          deploymentId: HISTORICAL_DEPLOYMENT_ID,
          runId: session.sessionId,
        });

        const failedRuns = await world.runs.list({
          pagination: { limit: 100 },
          resolveData: "none",
          status: "failed",
        });
        expect(failedRuns.data).toEqual([]);
        expect(followUpEvents.map((event) => event.type)).toContain("message.completed");
        expect(followUpEvents.map((event) => event.type)).toContain("session.waiting");
        expect(followUpEvents.map((event) => event.type)).not.toContain("turn.failed");
        expect(followUpEvents.map((event) => event.type)).not.toContain("session.failed");
      } finally {
        if (previousVercelEnvironment === undefined) {
          delete process.env.VERCEL_ENV;
        } else {
          process.env.VERCEL_ENV = previousVercelEnvironment;
        }
        try {
          await workflowWorld?.close();
        } finally {
          await Promise.all(apps.map(async (app) => await app.cleanup()));
        }
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function readUntilWaiting(
  stream: ReadableStream<MessageStreamEvent>,
): Promise<MessageStreamEvent[]> {
  const reader = stream.getReader();
  const events: MessageStreamEvent[] = [];
  const timeout = AbortSignal.timeout(60_000);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
  });
  try {
    while (!timeout.aborted) {
      const next = await Promise.race([reader.read(), timeoutPromise]);
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === "session.waiting") return events;
      if (next.value.type === "session.failed") {
        throw new Error(`Session failed: ${JSON.stringify(next.value.data)}`);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error(`Session did not park. Events: ${events.map((event) => event.type).join(", ")}`);
}

async function waitForRunToSettle(
  world: PromotableWorkflowWorld["world"],
  runId: string,
): Promise<Awaited<ReturnType<typeof world.runs.get>>> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const run = await world.runs.get(runId, { resolveData: "none" });
    if (run.status !== "pending" && run.status !== "running") return run;
    if (Date.now() >= deadline) {
      throw new Error(`Workflow run "${runId}" did not settle from ${run.status}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
