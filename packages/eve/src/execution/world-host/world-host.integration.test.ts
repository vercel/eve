import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { localWorld } from "#execution/world/local-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import type { DriveOutcome } from "./driver.js";
import { createWorldHost, type WorldHost, type WorldHostOptions } from "./host.js";

// Sessions that run only when something arrives for them. The World (Workflow's local World in
// a directory) keeps each session and delivers its wakes; each wake runs the session until it
// waits again, and nothing holds it between wakes.

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

/** Calls `deploy` until it has a result, then says how it went and what it was told before. */
function releaseModel(prompts: string[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const results = prompt
          .flatMap((message) => (message.role === "tool" ? message.content : []))
          .filter((part) => part.type === "tool-result");
        const users = prompt.filter((message) => message.role === "user").length;
        if (users > 1) return textStreamResult(`Turn ${users}.`);
        return results.length > 0
          ? textStreamResult(`Deploy: ${results.length}.`)
          : toolCallsStreamResult([
              { input: '{"env":"prod"}', toolCallId: "call-deploy", toolName: "deploy" },
            ]);
      },
      modelId: "world-host-scripted",
      provider: "eve-test",
    }),
  );
}

/** Calls `step` `steps` times, one call per model step, then says it's done. */
function stepsModel(steps: number) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const done = prompt
          .flatMap((message) => (message.role === "tool" ? message.content : []))
          .filter((part) => part.type === "tool-result").length;
        return done >= steps
          ? textStreamResult(`Done after ${done}.`)
          : toolCallsStreamResult([
              { input: "{}", toolCallId: `call-step-${done}`, toolName: "step" },
            ]);
      },
      modelId: "world-host-steps",
      provider: "eve-test",
    }),
  );
}

let dir: string;
let host: WorldHost | undefined;
const outcomes: { sessionId: string; outcome: DriveOutcome }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-world-host-"));
  outcomes.length = 0;
});
afterEach(async () => {
  await host?.close();
  await host?.world.close?.();
  host = undefined;
  rmSync(dir, { force: true, recursive: true });
});

async function serve(options: Omit<WorldHostOptions, "world">): Promise<WorldHost> {
  host = createWorldHost({
    ...options,
    observe: ({ outcome, sessionId }) => outcomes.push({ outcome, sessionId }),
    world: localWorld({ dataDir: join(dir, "world") }),
  });
  await host.serve();
  return host;
}

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The last delivery's outcome for `sessionId`. */
const lastOutcome = (sessionId: string) =>
  outcomes.filter((entry) => entry.sessionId === sessionId).at(-1)?.outcome;

describe("a World host", () => {
  it("runs a turn when a message arrives, holds nothing while an approval waits, and runs the tool once approved", async () => {
    const deployed: unknown[] = [];
    const callers: (string | undefined)[] = [];
    const prompts: string[] = [];
    const agent = defineAgent({
      instructions: "You release things.",
      model: releaseModel(prompts),
      modelContextWindowTokens: 200_000,
      name: "release",
      tools: {
        deploy: defineTool({
          approval: always(),
          description: "Deploy.",
          execute: async (input: Record<string, unknown>, ctx) => {
            deployed.push(input);
            callers.push(ctx.session.auth.current?.principalId);
            return { ok: true };
          },
          inputSchema: { properties: { env: { type: "string" } }, type: "object" },
        }),
      },
    });
    const world = await serve({ agents: [agent] });
    const session = world.session("release", { identity: alice });

    const asked = await (await session.send("Ship it.")).result();
    expect(asked.interactions.map((interaction) => interaction.call?.name)).toEqual(["deploy"]);
    // The wake that ran the turn ended once it waited on the approval: nothing holds it.
    await until(() => lastOutcome(asked.sessionId)?.kind === "waiting");
    expect(deployed).toEqual([]);

    const pending = await session.pending();
    const answered = await (
      await session.respond([{ interactionId: pending[0]!.interactionId, optionId: "approve" }])
    ).result();
    expect(answered.reply).toBe("Deploy: 1.");
    expect(answered.sessionId).toBe(asked.sessionId);
    expect(deployed).toEqual([{ env: "prod" }]);
    expect(callers).toEqual(["alice"]);

    // The next message continues the conversation, from another wake.
    const next = await (await session.send("And now?")).result();
    expect(next.reply).toBe("Turn 2.");
    expect(prompts.at(-1)).toContain("Ship it.");
    expect(deployed).toHaveLength(1);
    // Three wakes ran it (the message, the approval, the next message), each to a wait.
    await until(
      () =>
        outcomes.filter(
          (entry) => entry.sessionId === asked.sessionId && entry.outcome.kind === "waiting",
        ).length >= 3,
    );
  }, 60_000);

  it("hands a turn longer than one delivery to the next, and runs each call once", async () => {
    const ran: number[] = [];
    const agent = defineAgent({
      model: stepsModel(4),
      modelContextWindowTokens: 200_000,
      name: "worker",
      tools: {
        step: defineTool({
          description: "One slow step.",
          execute: async () => {
            ran.push(Date.now());
            await new Promise((resolve) => setTimeout(resolve, 600));
            return { ok: true };
          },
          inputSchema: { properties: {}, type: "object" },
        }),
      },
    });
    const world = await serve({ agents: [agent], deliveryBudgetMs: 900 });
    const session = world.session("worker", { identity: alice });
    const done = await (await session.send("Work.")).result();
    expect(done.reply).toBe("Done after 4.");
    expect(ran).toHaveLength(4);
    const kinds = outcomes
      .filter((entry) => entry.sessionId === done.sessionId)
      .map((entry) => entry.outcome.kind);
    expect(kinds).toContain("handoff");
    // The wake that finished the turn reports once the session waits again.
    await until(() => lastOutcome(done.sessionId)?.kind === "waiting");
  }, 60_000);

  it("ends an idle session on its timeout, from a wake its timer armed after it stopped", async () => {
    const agent = defineAgent({
      limits: { sessionTimeoutMs: 5_000 },
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async () => textStreamResult("Hello."),
          modelId: "hello",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "greeter",
    });
    const world = await serve({ agents: [agent] });
    const session = world.session("greeter", { identity: alice });
    const hello = await (await session.send("Hi.")).result();
    expect(hello.reply).toBe("Hello.");
    await until(() => lastOutcome(hello.sessionId)?.kind === "waiting");
    const waiting = lastOutcome(hello.sessionId);
    expect(waiting).toMatchObject({ kind: "waiting" });
    expect((waiting as { wakeAt?: number }).wakeAt).toBeGreaterThan(Date.now());

    const types: string[] = [];
    const events = await session.events();
    const reader = events.getReader();
    const readAll = (async () => {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        types.push((next.value as SessionStreamEvent).type);
        if (next.value.type === "session.ended") return;
      }
    })();
    await Promise.race([
      readAll,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no session.ended")), 20_000)),
    ]);
    await reader.cancel().catch(() => {});
    expect(types).toContain("session.ended");
  }, 60_000);

  it("runs a subagent's session beside its parent's, and the parent replies with its answer", async () => {
    const reviewer = defineAgent({
      description: "Reviews a release before it ships.",
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async () => textStreamResult("The release looks good."),
          modelId: "reviewer",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
    });
    const release = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            if (JSON.stringify(prompt).includes("The release looks good."))
              return textStreamResult("Review: the release looks good.");
            const results = prompt
              .flatMap((message) => (message.role === "tool" ? message.content : []))
              .filter((part) => part.type === "tool-result");
            return results.length > 0
              ? textStreamResult("I asked the reviewer.")
              : toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "Review the release, please." }),
                    toolCallId: "call-review",
                    toolName: "reviewer",
                  },
                ]);
          },
          modelId: "release",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "release",
      subagents: { reviewer },
    });
    const world = await serve({ agents: [release] });
    const session = world.session("release", { identity: alice });
    const asked = await (await session.send("Ship it?")).result();
    // The review is the call's result in this turn, or comes back as the task's result and
    // starts the parent's next one: either way the parent replies with it.
    const texts: string[] = [];
    const reader = (await session.events()).getReader();
    const read = (async () => {
      for (let next = await reader.read(); !next.done; next = await reader.read())
        if (JSON.stringify(next.value).includes("Review: the release looks good.")) {
          texts.push("review");
          return;
        }
    })();
    await Promise.race([
      read,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no review")), 20_000)),
    ]);
    await reader.cancel().catch(() => {});
    expect(texts).toEqual(["review"]);
    await until(() => lastOutcome(asked.sessionId)?.kind === "waiting");
  }, 60_000);

  it("fires a schedule once per occurrence, however many processes tick", async () => {
    const prompts: string[] = [];
    const agent = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            prompts.push(JSON.stringify(prompt));
            return textStreamResult("Reported.");
          },
          modelId: "reporter",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "reporter",
    });
    const world = await serve({
      agents: [agent],
      schedules: {
        daily: { agent: "reporter", schedule: { content: "Write the report.", cron: "* * * * *" } },
      },
    });
    const at = new Date();
    expect(await world.tick(at)).toEqual(["daily"]);
    expect(await world.tick(new Date(at.getTime() + 1))).toEqual([]);
    await until(() => prompts.some((prompt) => prompt.includes("Write the report.")));
    await until(() => outcomes.some((entry) => entry.outcome.kind === "waiting"));
    expect(prompts.filter((prompt) => prompt.includes("Write the report."))).toHaveLength(1);
  }, 60_000);
});
