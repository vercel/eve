import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorldSessionStore } from "#execution/in-process/world-store.js";
import type { RuntimeWorld } from "#execution/world/runtime-world.js";
import { localTestWorld } from "#internal/testing/local-world.js";

import type { SessionAuthContext } from "#channel/types.js";
import { eve } from "#definitions/defaults.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createSession, type EmbeddedSession } from "#embed/session.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { dataField } from "#internal/testing/in-process-sessions.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { memorySandbox } from "#runtime/sandbox/memory-sandbox.js";

// Suspending a session is not ending it. Alice's lead agent writes a plan in its memory sandbox
// and asks its reviewer about it. Suspended while the reviewer works, with a store keeping it,
// the session restores in a fresh runtime with its files and its reviewer's run: neither was
// torn down. Closing it ends it: the session and the reviewer it opened record their end.

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

/** The reviewer: it answers once `release()`, or stops when its turn is cancelled. */
function reviewerGate() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached: () => void = () => {};
  const started = new Promise<void>((resolve) => (reached = resolve));
  let calls = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        calls++;
        reached();
        await Promise.race([
          released,
          new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve())),
        ]);
        return textStreamResult("Plan looks good.");
      },
      modelId: "reviewer",
      provider: "eve-test",
    }),
  );
  return { calls: () => calls, model, release, started };
}

/**
 * The lead: writes `plan.md`, asks its reviewer, says it waits; once the review is in, reads
 * `plan.md` back and replies with what it read.
 */
function leadAgent(reviewer: ReturnType<typeof reviewerGate>) {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []))
            : [],
        );
        if (results.length >= 3)
          return textStreamResult(`Read: ${JSON.stringify(results.at(-1)?.output)}`);
        if (JSON.stringify(prompt).includes("Plan looks good."))
          return toolCallsStreamResult([
            {
              input: JSON.stringify({ filePath: "plan.md" }),
              toolCallId: "call-read",
              toolName: "read_file",
            },
          ]);
        if (results.length === 2) return textStreamResult("Waiting on the reviewer.");
        return toolCallsStreamResult([
          results.length === 0
            ? {
                input: JSON.stringify({ content: "Ship on Friday.\n", filePath: "plan.md" }),
                toolCallId: "call-write",
                toolName: "write_file",
              }
            : {
                input: JSON.stringify({ message: "Review plan.md, please." }),
                toolCallId: "call-review",
                toolName: "reviewer",
              },
        ]);
      },
      modelId: "lead",
      provider: "eve-test",
    }),
  );
  return defineAgent({
    definitions: eve.defaults({
      sandbox: memorySandbox(),
      without: ["agent", "bash", "web_fetch", "web_search"],
    }),
    model,
    modelContextWindowTokens: 200_000,
    name: "lead",
    subagents: {
      reviewer: defineAgent({
        description: "Reviews a plan.",
        model: reviewer.model,
        modelContextWindowTokens: 200_000,
      }),
    },
  });
}

/** Reads `session`'s events until `done` says so. */
async function until(
  session: EmbeddedSession,
  done: (events: readonly SessionStreamEvent[]) => boolean,
): Promise<SessionStreamEvent[]> {
  const reader = (await session.events()).getReader();
  const events: SessionStreamEvent[] = [];
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      events.push(next.value);
      if (done(events)) break;
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

const said = (events: readonly SessionStreamEvent[], text: string) =>
  events.some(
    (event) =>
      event.type === "content.completed" && String(dataField(event, "value")).startsWith(text),
  );

/** Every line `world` kept of `sessionId`. */
async function linesOf(world: RuntimeWorld, sessionId: string): Promise<string> {
  return ((await createWorldSessionStore(world).load(sessionId))?.lines ?? []).join("\n");
}

describe("suspending and ending an embedded session", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eve-suspend-"));
  });
  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("suspends a kept session with its sandbox files and its reviewer's run, which a fresh runtime continues", async () => {
    const reviewer = reviewerGate();
    const lead = leadAgent(reviewer);
    const world = localTestWorld(directory);
    const first = createSession(lead, { identity: alice, world });
    await first.send("Write the plan, and ask the reviewer.");
    await reviewer.started;
    await until(first, (seen) => said(seen, "Waiting on the reviewer."));
    const sessionId = first.id!;
    // The process quits while the reviewer works: nothing of the session is torn down.
    const suspending = first.suspend();
    reviewer.release();
    await suspending;
    const saved = await createWorldSessionStore(world).load(sessionId);
    expect(saved?.runs).toMatchObject([{ input: { callId: "call-review" } }]);
    const [reviewerId] = saved?.runs?.[0]?.children ?? [];
    expect(reviewerId).toBeDefined();
    expect(await linesOf(world, sessionId)).not.toContain('"session.ended"');
    expect(await linesOf(world, reviewerId!)).not.toContain('"session.ended"');

    const second = createSession(lead, { identity: alice, resume: sessionId, world });
    try {
      const events = await until(second, (seen) => said(seen, "Read: "));
      // The reviewer's run went on and reached the reviewer the store kept; its cut-off step
      // ran once more.
      expect(
        events.filter((event) => event.type === "call.settled").map((event) => event.data),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callId: "call-review", outcome: "completed" }),
        ]),
      );
      expect(reviewer.calls()).toBe(2);
      // The plan the first runtime wrote is still in the sandbox.
      const read = events.find(
        (event) => event.type === "call.settled" && dataField(event, "callId") === "call-read",
      );
      expect(read === undefined ? undefined : dataField(read, "outcome")).toBe("completed");
      expect(JSON.stringify(read?.data)).toContain("Ship on Friday.");
    } finally {
      await second.close();
    }
  }, 90_000);

  it("ends a session on close, and the reviewer it opened with it", async () => {
    const reviewer = reviewerGate();
    const world = localTestWorld(directory);
    const session = createSession(leadAgent(reviewer), { identity: alice, world });
    await session.send("Write the plan, and ask the reviewer.");
    await reviewer.started;
    await until(session, (seen) => said(seen, "Waiting on the reviewer."));
    const sessionId = session.id!;
    const [reviewerId] =
      (await createWorldSessionStore(world).load(sessionId))?.runs?.[0]?.children ?? [];
    expect(reviewerId).toBeDefined();

    await session.close();
    expect(await linesOf(world, sessionId)).toContain('"session.ended"');
    expect(await linesOf(world, reviewerId!)).toContain('"session.ended"');
    expect(reviewer.calls()).toBe(1);
  }, 90_000);
});
