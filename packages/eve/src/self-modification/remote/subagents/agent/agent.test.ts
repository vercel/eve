import { ContextContainer, contextStorage } from "#context/container.js";
import type { SessionAuthContext } from "#context/keys.js";
import { openMemos, type MemoRun } from "#definitions/memos.js";
import { dynamicEvaluate } from "#dynamic/definition.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import selfModification from "../../extension.js";
import agent from "./agent.js";

const person = (principalId: string): SessionAuthContext => ({
  attributes: {},
  authenticator: "slack",
  principalId,
  principalType: "user",
});
const alice = person("alice");
const bob = person("bob");

/** Mounts the deployed extension so only `authorized` may propose changes. */
function mount(authorized: readonly SessionAuthContext[]): void {
  selfModification({
    authorize: ({ principal }) =>
      authorized.some((allowed) => allowed.principalId === principal?.principalId),
    credentials: { resolve: async () => "github-token" },
    source: { git: { directory: ".", repository: "github.com/acme/agent" } },
    target: { branch: "main" },
  });
}

/** The session's memos for one evaluation, keeping what an earlier evaluation of the turn used. */
function memos(kept?: MemoRun): MemoRun {
  return openMemos({
    abortSignal: new AbortController().signal,
    kept: kept?.used(),
    label: "subagents/agent/agent.ts",
    scope: "subagents/agent",
    sessionId: "session",
  });
}

/** Evaluates the subagent in Alice's turn, after `sender` spoke last. */
function offerInAliceTurn(sender: SessionAuthContext | null, run = memos()) {
  return contextStorage.run(new ContextContainer(), () => evaluate(sender, run));
}

function evaluate(sender: SessionAuthContext | null, run: MemoRun) {
  return dynamicEvaluate(agent)({
    channel: { kind: "channel:slack", metadata: {} },
    memo: run.memo,
    model: { id: "openai/gpt-6-luna-fast" },
    session: { auth: { current: alice, initiator: alice, sender }, id: "session" },
    turn: { id: "turn-1" },
  } as never);
}

describe("deployed self-modification agent in a shared session", () => {
  beforeEach(() => {
    vi.stubEnv("EVE_DEV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { label: "an authorized caller who spoke last", authorized: [alice], sender: alice },
    {
      label: "an authorized caller after another authorized person spoke",
      authorized: [alice, bob],
      sender: bob,
    },
  ])("is offered to $label", async ({ authorized, sender }) => {
    mount(authorized);

    await expect(offerInAliceTurn(sender)).resolves.toMatchObject({
      model: "openai/gpt-6-luna-fast",
    });
  });

  it.each([
    { label: "an unauthorized person spoke last", authorized: [alice], sender: bob },
    { label: "someone without an identity spoke last", authorized: [alice], sender: null },
    { label: "only the person who spoke last is authorized", authorized: [bob], sender: bob },
  ])("is not offered to the caller when $label", async ({ authorized, sender }) => {
    mount(authorized);

    await expect(offerInAliceTurn(sender)).resolves.toBeNull();
  });

  it("asks again within the turn once someone else speaks", async () => {
    mount([alice]);
    const beforeBobSpoke = memos();
    await expect(offerInAliceTurn(alice, beforeBobSpoke)).resolves.not.toBeNull();

    await expect(offerInAliceTurn(bob, memos(beforeBobSpoke))).resolves.toBeNull();
  });
});
