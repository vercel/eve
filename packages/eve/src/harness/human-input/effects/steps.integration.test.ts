import { describe, expect, it, vi } from "vitest";

import { readDurableSession } from "#execution/durable-session-store.js";
import { forwardRelayedAnswersStep } from "#harness/human-input/effects/steps.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { HumanInput } from "#harness/human-input/index.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { InputRequest } from "#shared/input.js";

// The child sessions are not running here; the test reads what reached their inboxes.
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "support-session",
};

function question(requestId: string, prompt: string): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "ask" },
    kind: "question",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    prompt,
    requestId,
  };
}

/** Alice's session relays a question from each of Bob's and Carol's reviewer sessions. */
function relaying() {
  const base = createTestSessionState({ sessionId: "support-session" });
  let humanInput = HumanInput.read(base.snapshot.session.state);
  for (const [name, sequence] of [
    ["bob", 3],
    ["carol", 5],
  ] as const) {
    humanInput = humanInput.interrupt({
      at: { sequence, stepIndex: 1, turnId: `${name}_turn_0` },
      requests: [question(`${name}-ask`, `Where should ${name} deploy?`)],
      route: { childContinuationToken: `${name}-token` },
      type: "relayed.requested",
    }).humanInput;
  }
  const session = {
    ...base.snapshot.session,
    state: humanInput.write(base.snapshot.session.state),
  };
  return { ...base, snapshot: { session } };
}

async function forward(delivery: Parameters<typeof forwardRelayedAnswersStep>[0]["delivery"]) {
  const events: MessageStreamEvent[] = [];
  const decoder = new TextDecoder();
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push(JSON.parse(decoder.decode(chunk)) as MessageStreamEvent);
    },
  });
  const runtime = await createTestRuntime({ agent: { name: "support" } });
  const result = await runtime.run(() =>
    runSessionStateStep(
      { delivery, serializedContext, sessionState: relaying(), sessionWritable },
      forwardRelayedAnswersStep,
    ),
  );
  return { events, result };
}

describe("forwardRelayedAnswersStep", () => {
  it("sends each answer to the child that asked and relays its resolution, keeping the rest for the turn", async () => {
    vi.mocked(resumeSessionInbox).mockReset();

    const { events, result } = await forward({
      kind: "deliver",
      payloads: [
        {
          inputResponses: [
            { optionId: "staging", requestId: "bob-ask" },
            { optionId: "approve", requestId: "alice-own" },
          ],
        },
      ],
    });

    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith("bob-token", {
      deliveryMetadata: undefined,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "staging", requestId: "bob-ask" }] }],
    });
    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          resolutions: [expect.objectContaining({ outcome: "answered", requestId: "bob-ask" })],
          sequence: 3,
          turnId: "bob_turn_0",
        }),
        type: "input.resolved",
      }),
    ]);
    expect(result).toMatchObject({
      kind: "continue",
      remainder: {
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "alice-own" }] }],
      },
    });
    expect(
      HumanInput.read(readDurableSession(result.sessionState).state).relayedRequestIds(),
    ).toEqual(new Set(["carol-ask"]));
  });

  it("drops a typed reply that answered the only relayed question with its context, keeping its channel state", async () => {
    vi.mocked(resumeSessionInbox).mockReset();
    const base = relaying();
    const carolOnly = HumanInput.read(base.snapshot.session.state).intake({
      responses: [{ optionId: "staging", requestId: "bob-ask" }],
      type: "delivered",
    }).humanInput;
    const sessionState = {
      ...base,
      snapshot: {
        session: { ...base.snapshot.session, state: carolOnly.write(base.snapshot.session.state) },
      },
    };
    const runtime = await createTestRuntime({ agent: { name: "support" } });

    const result = await runtime.run(() =>
      runSessionStateStep(
        {
          delivery: {
            kind: "deliver",
            payloads: [
              {
                context: ["<telegram_context>\nmessage_id: 7\n</telegram_context>"],
                message: "production",
                state: { messageId: "7" },
              },
            ],
          },
          serializedContext,
          sessionState,
          sessionWritable: new WritableStream<Uint8Array>(),
        },
        forwardRelayedAnswersStep,
      ),
    );

    expect(resumeSessionInbox).toHaveBeenCalledWith(
      "carol-token",
      expect.objectContaining({
        payloads: [{ inputResponses: [{ optionId: "production", requestId: "carol-ask" }] }],
      }),
    );
    expect(result).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ state: { messageId: "7" } }] },
    });
  });
});
