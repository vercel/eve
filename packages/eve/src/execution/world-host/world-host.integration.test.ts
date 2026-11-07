import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { localWorld } from "#execution/world/local-world.js";
import type { QueueWorld } from "#execution/world/runtime-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { APPROVE_OPTION_ID } from "#shared/input.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import type { ActivationOutcome } from "#execution/entity/entities.js";
import { createWorldHost, type WorldHost, type WorldHostOptions } from "./host.js";

/** The World run a session's entity is. */
const sessionRunId = (sessionId: string) => sessionId.replace(/^session_/, "wrun_");

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
const outcomes: { sessionId: string; outcome: ActivationOutcome }[] = [];

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

async function serve(
  options: Omit<WorldHostOptions, "world">,
  wrap: (world: QueueWorld) => QueueWorld = (world) => world,
): Promise<WorldHost> {
  host = createWorldHost({
    ...options,
    observe: ({ outcome, sessionId }) => outcomes.push({ outcome, sessionId }),
    world: wrap(localWorld({ dataDir: join(dir, "world") })),
  });
  await host.serve();
  return host;
}

async function until(condition: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
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
    await until(() => lastOutcome(asked.sessionId)?.kind === "idle");
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
          (entry) => entry.sessionId === asked.sessionId && entry.outcome.kind === "idle",
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
    expect(kinds).toContain("continue");
    // The wake that finished the turn reports once the session waits again.
    await until(() => lastOutcome(done.sessionId)?.kind === "idle");
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
    await until(() => lastOutcome(hello.sessionId)?.kind === "idle");
    const waiting = lastOutcome(hello.sessionId);
    expect(waiting).toMatchObject({ kind: "idle" });
    expect((waiting as { alarm?: number }).alarm).toBeGreaterThan(Date.now());

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
    await until(() => lastOutcome(asked.sessionId)?.kind === "idle");
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
    await until(() => outcomes.some((entry) => entry.outcome.kind === "idle"));
    expect(prompts.filter((prompt) => prompt.includes("Write the report."))).toHaveLength(1);
  }, 60_000);
  it("reads what arrived since its last wake, and none of its stream's lines, to continue a session", async () => {
    // What the World hands back for the session's run: events listed, and lines read from 0.
    const read = { forward: 0, backward: 0, linesFromStart: 0 };
    const counting = (world: QueueWorld): QueueWorld => ({
      ...world,
      events: {
        ...world.events,
        list: async (params) => {
          const page = await world.events.list(params);
          if (params.runId.startsWith("wrun_") && params.pagination?.limit !== 1000) {
            if (params.pagination?.sortOrder === "asc") read.forward += page.data.length;
            else read.backward += page.data.length;
          }
          return page;
        },
      },
      streams: {
        ...world.streams,
        getChunks: async (runId, name, chunks) => {
          const page = await world.streams.getChunks(runId, name, chunks);
          if (chunks?.cursor === undefined) read.linesFromStart += page.data.length;
          return page;
        },
      },
    });
    const agent = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) =>
            textStreamResult(`Turn ${prompt.filter((m) => m.role === "user").length}.`),
          modelId: "turns",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "talker",
    });
    const world = await serve({ agents: [agent] }, counting);
    const session = world.session("talker", { identity: alice });
    let sessionId = "";
    const logLength = async () =>
      (
        await world.world.events.list({
          pagination: { limit: 1000, sortOrder: "asc" },
          resolveData: "none",
          runId: sessionRunId(sessionId),
        })
      ).data.length;
    // Wake 4 saves its cursor where it read message 4's arrival, so wake 5 reads from at most
    // here: what was written after message 4 was sent.
    let beforeFourth = 0;
    for (let turn = 1; turn <= 4; turn += 1) {
      if (turn === 4) beforeFourth = await logLength();
      const reply = await (await session.send(`Message ${turn}.`)).result();
      expect(reply.reply).toBe(`Turn ${turn}.`);
      sessionId = reply.sessionId;
      await until(() => outcomes.filter((entry) => entry.outcome.kind === "idle").length >= turn);
    }
    const before = { ...read };
    const last = await (await session.send("Message 5.")).result();
    expect(last.reply).toBe("Turn 5.");
    await until(() => outcomes.filter((entry) => entry.outcome.kind === "idle").length >= 5);
    const log = await logLength();
    // The fifth wake reads its first page and what was written since message 4, forward, and its
    // state once, backward to the last whole one. It reads no line to restore.
    expect(read.forward - before.forward).toBeLessThanOrEqual(20 + (log - beforeFourth));
    expect(read.backward - before.backward).toBeLessThanOrEqual(log);
    expect(read.linesFromStart - before.linesFromStart).toBe(0);
  }, 60_000);

  it("sleeps again on an alarm that came early with nothing arrived, without activating the session", async () => {
    const agent = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async () => textStreamResult("Hello."),
          modelId: "hello",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "sleeper",
    });
    const queued: unknown[] = [];
    const world = await serve({ agents: [agent] }, (inner) => ({
      ...inner,
      queue: async (name, message, options) => {
        queued.push(message);
        return await inner.queue(name, message, options);
      },
    }));
    const hello = await (await world.session("sleeper", { identity: alice }).send("Hi.")).result();
    await until(() => lastOutcome(hello.sessionId)?.kind === "idle");
    const seen = (
      await world.world.events.list({
        pagination: { limit: 1, sortOrder: "desc" },
        resolveData: "none",
        runId: sessionRunId(hello.sessionId),
      })
    ).data[0]?.eventId;
    const early = {
      at: Date.now() + 60 * 60 * 1000,
      runId: sessionRunId(hello.sessionId),
      runSpecVersion: 9,
      seen,
    };
    const wakes = outcomes.length;
    queued.length = 0;
    await world.deliver(early, { attempt: 1, messageId: "early" });
    // Armed again for the same deadline, and nothing ran the session.
    expect(queued).toEqual([early]);
    expect(outcomes).toHaveLength(wakes);
    // Once something arrived after it was armed, the wake runs the session.
    await (
      await world.session("sleeper", { identity: alice, resume: hello.sessionId }).send("Again.")
    ).result();
    await until(() => outcomes.length > wakes);
    const after = outcomes.length;
    await world.deliver(early, { attempt: 1, messageId: "early" });
    expect(outcomes.length).toBeGreaterThan(after);
  }, 60_000);
  it("hands off a turn whose deadline comes during its last model step, and the next delivery settles it", async () => {
    let replies = 0;
    const agent = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const done = prompt
              .flatMap((message) => (message.role === "tool" ? message.content : []))
              .filter((part) => part.type === "tool-result").length;
            if (done === 0)
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "call-step", toolName: "step" },
              ]);
            // The reply outlasts what's left of the delivery.
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            replies += 1;
            return textStreamResult("Done.");
          },
          modelId: "world-host-slow-reply",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "slow",
      tools: {
        step: defineTool({
          description: "One step.",
          execute: async () => ({ ok: true }),
          inputSchema: { properties: {}, type: "object" },
        }),
      },
    });
    const world = await serve({ agents: [agent], deliveryBudgetMs: 1_000 });
    const session = world.session("slow", { identity: alice });
    const done = await (await session.send("Go.")).result();
    expect(done.reply).toBe("Done.");
    await until(() => lastOutcome(done.sessionId)?.kind === "idle");
    const kinds = outcomes
      .filter((entry) => entry.sessionId === done.sessionId)
      .map((entry) => entry.outcome.kind);
    expect(kinds).toContain("continue");
    // The next message runs a turn of its own.
    const next = await (await session.send("Again.")).result();
    expect(next.reply).toBe("Done.");
  }, 60_000);
  it("hands off the turn an approval resumed, during its last model step, and the next delivery settles it", async () => {
    const agent = defineAgent({
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const results = prompt
              .flatMap((message) => (message.role === "tool" ? message.content : []))
              .filter((part) => part.type === "tool-result");
            const users = prompt.filter((message) => message.role === "user").length;
            if (users > 1) return textStreamResult(`Turn ${users}.`);
            if (results.length === 0)
              return toolCallsStreamResult([
                { input: '{"env":"prod"}', toolCallId: "call-deploy", toolName: "deploy" },
              ]);
            // The reply outlasts what's left of the delivery the approval woke.
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            return textStreamResult("Deployed.");
          },
          modelId: "world-host-approval-slow-reply",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "approver",
      tools: {
        deploy: defineTool({
          approval: always(),
          description: "Deploy.",
          execute: async () => ({ ok: true }),
          inputSchema: { properties: { env: { type: "string" } }, type: "object" },
        }),
      },
    });
    const world = await serve({ agents: [agent], deliveryBudgetMs: 1_000 });
    const session = world.session("approver", { identity: alice });
    const asked = await (await session.send("Ship it.")).result();
    await until(() => lastOutcome(asked.sessionId)?.kind === "idle");
    const pending = await session.pending();
    const before = outcomes.length;
    const answered = await (
      await session.respond([{ interactionId: pending[0]!.interactionId, optionId: "approve" }])
    ).result();
    expect(answered.reply).toBe("Deployed.");
    // Sent while the delivery the approval woke is still running: the next delivery takes it.
    const next = await (await session.send("And now?")).result();
    expect(next.reply).toBe("Turn 2.");
    await until(
      () => outcomes.length > before + 1 && lastOutcome(asked.sessionId)?.kind === "idle",
    );
    expect(outcomes.slice(before).map((entry) => entry.outcome.kind)).toContain("continue");
  }, 60_000);
  it("reads a message that waited behind a budget question with the turn it waited on, after the session stopped between", async () => {
    const requests: string[][] = [];
    const agent = defineAgent({
      instructions: "You write notes.",
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const users = prompt
              .filter((message) => message.role === "user")
              .map((message) =>
                message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
              );
            requests.push(users);
            return textStreamResult(`Reply ${String(requests.length)}.`);
          },
          modelId: "world-host-budget",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "notes",
      // The first turn spends the whole budget, so the next one parks on the question.
      limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
    });
    const world = await serve({ agents: [agent] });
    const session = world.session("notes", { identity: alice });

    const first = await (await session.send("Write a summary.")).result();
    await until(() => lastOutcome(first.sessionId)?.kind === "idle");
    await session.send("Write a status note.");
    await until(async () => (await session.pending()).length > 0);
    const [question] = await session.pending();
    expect(question?.request.kind).toBe("budget");
    // Held behind the question, while nothing runs the session.
    const idle = outcomes.length;
    await session.send("Mention the deadline.");
    await until(() => outcomes.length > idle && lastOutcome(first.sessionId)?.kind === "idle");
    const model = requests.length;

    const answered = await (
      await session.respond([
        { interactionId: question!.interactionId, optionId: APPROVE_OPTION_ID },
      ])
    ).result();
    expect(answered.sessionId).toBe(first.sessionId);
    expect(requests.length).toBe(model + 1);
    expect(requests.at(-1)).toEqual([
      "Write a summary.",
      "Write a status note.",
      "Mention the deadline.",
    ]);
  }, 60_000);

  // Known bug, kept failing until fixed: the resumed turn's prompt holds the message twice. The
  // snapshot redelivers it once (one unread input, no admitted keys) and the mailbox hands over only
  // the answer, so the second copy comes from how the resumed turn admits a held delivery.
  it("reads a message that waited behind a budget question with the turn it waited on, when it arrived as the question did", async () => {
    const requests: string[][] = [];
    const agent = defineAgent({
      instructions: "You write notes.",
      model: markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const users = prompt
              .filter((message) => message.role === "user")
              .map((message) =>
                message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
              );
            requests.push(users);
            return textStreamResult(`Reply ${String(requests.length)}.`);
          },
          modelId: "world-host-budget",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "notes",
      // The first turn spends the whole budget, so the next one parks on the question.
      limits: { sessionUsage: ({ window }) => window.inputTokens >= 1 },
    });
    const world = await serve({ agents: [agent] });
    const session = world.session("notes", { identity: alice });

    const first = await (await session.send("Write a summary.")).result();
    await until(() => lastOutcome(first.sessionId)?.kind === "idle");
    await session.send("Write a status note.");
    await until(async () => (await session.pending()).length > 0, 15_000);
    const [question] = await session.pending();
    expect(question?.request.kind).toBe("budget");
    // Held behind the question, as the activation that asked it still runs.
    const idle = outcomes.length;
    await session.send("Mention the deadline.");
    await until(() => outcomes.length > idle + 1 && lastOutcome(first.sessionId)?.kind === "idle");
    const model = requests.length;

    const answered = await (
      await session.respond([
        { interactionId: question!.interactionId, optionId: APPROVE_OPTION_ID },
      ])
    ).result();
    expect(answered.sessionId).toBe(first.sessionId);
    expect(requests.length).toBe(model + 1);
    expect(requests.at(-1)).toEqual([
      "Write a summary.",
      "Write a status note.",
      "Mention the deadline.",
    ]);
  }, 60_000);
});
