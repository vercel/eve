import { describe, expect, it, vi } from "vitest";

import { sessionView } from "#harness/session-machine/commit.js";
import { fail } from "#harness/session-machine/transitions.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { createDefaultEvents } from "#public/channels/linear/defaults.js";
import type {
  LinearChannelState,
  LinearEventContext,
} from "#public/channels/linear/linearChannel.js";

function sessionContext(): SessionContext {
  return {
    getSandbox: vi.fn(),
    session: {
      auth: {
        current: {
          attributes: {},
          authenticator: "linear-agent-webhook",
          principalId: "linear:user_1",
          principalType: "user",
          subject: "user_1",
        },
        initiator: null,
      },
      id: "test-session",
      turn: { id: "test-turn", sequence: 0 },
    },
  };
}

function buildChannelStub(): LinearEventContext {
  return {
    state: {
      agentSessionId: "agent_session_1",
      pendingToolCallMessage: null,
    } as LinearChannelState,
  } as LinearEventContext;
}

function buildEvents() {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            agentActivityCreate: {
              agentActivity: { id: "activity_1" },
              success: true,
            },
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
  );
  return {
    events: createDefaultEvents({
      api: { fetch },
      credentials: { accessToken: "linear-token" },
    }),
    fetch,
  };
}

function activityInput(fetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const request = fetch.mock.calls[0]?.[1] as RequestInit;
  const body = JSON.parse(String(request.body)) as {
    variables: { input: Record<string, unknown> };
  };
  return body.variables.input;
}

/** Delivers a failed step's events to the default handlers, as the Linear adapter does. */
async function failStep(
  events: ReturnType<typeof buildEvents>["events"],
  terminal: { sessionId: string } | undefined,
): Promise<void> {
  const failure = fail(sessionView(initialSessionProjection(), undefined), {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err_1" },
    message: "The provider rejected the request",
    terminal,
  });
  for (const event of failure.events) {
    const handler = events[event.type as keyof typeof events] as
      | ((data: unknown, channel: LinearEventContext, ctx: SessionContext) => Promise<void>)
      | undefined;
    await handler?.("data" in event ? event.data : undefined, buildChannelStub(), sessionContext());
  }
}

function errorNotices(fetch: ReturnType<typeof vi.fn>): string[] {
  return fetch.mock.calls
    .map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        variables: { input: { content: { body?: string; type: string } } };
      };
      return body.variables.input.content;
    })
    .filter((content) => content.type === "error")
    .map((content) => content.body ?? "");
}

describe("createDefaultEvents failure notices", () => {
  it("posts only the restart notice when a failed turn ends the session", async () => {
    const { events, fetch } = buildEvents();

    await failStep(events, { sessionId: "test-session" });

    expect(errorNotices(fetch)).toEqual([
      expect.stringContaining("Start a new Linear agent session to continue."),
    ]);
  });

  it("posts only the retry notice when the session waits after a failed turn", async () => {
    const { events, fetch } = buildEvents();

    await failStep(events, undefined);

    expect(errorNotices(fetch)).toEqual([
      expect.stringContaining("Please try again, rephrase, or reach out if it keeps failing."),
    ]);
  });
});

describe("createDefaultEvents authorization.required", () => {
  it("posts Linear's native auth elicitation for the triggering user", async () => {
    const { events, fetch } = buildEvents();

    await events["authorization.required"]!(
      {
        authorization: {
          displayName: "Notion Workspace",
          url: "https://connect.example.com/a/sca_1",
        },
        description: "Authorization required for notion",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      buildChannelStub(),
      sessionContext(),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(activityInput(fetch)).toEqual({
      agentSessionId: "agent_session_1",
      content: {
        body: "Authorization required for Notion Workspace.",
        type: "elicitation",
      },
      signal: "auth",
      signalMetadata: {
        providerName: "Notion Workspace",
        url: "https://connect.example.com/a/sca_1",
        userId: "user_1",
      },
    });
  });

  it("renders URL-less device authorization instructions without an auth signal", async () => {
    const { events, fetch } = buildEvents();

    await events["authorization.required"]!(
      {
        authorization: {
          instructions: "Open Notion on your phone.",
          userCode: "OTB-DGO",
        },
        description: "Authorization required for notion",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      buildChannelStub(),
      sessionContext(),
    );

    expect(activityInput(fetch)).toEqual({
      agentSessionId: "agent_session_1",
      content: {
        body: "Authorization required for Notion.\n\nOpen Notion on your phone.\n\nCode: OTB-DGO",
        type: "elicitation",
      },
    });
  });
});

describe("createDefaultEvents authorization.completed", () => {
  it("posts an ephemeral resuming thought after authorization succeeds", async () => {
    const { events, fetch } = buildEvents();

    await events["authorization.completed"]!(
      {
        authorization: { displayName: "Notion Workspace" },
        name: "notion",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      },
      buildChannelStub(),
      sessionContext(),
    );

    expect(activityInput(fetch)).toEqual({
      agentSessionId: "agent_session_1",
      content: {
        body: "Connected to Notion Workspace. Resuming.",
        type: "thought",
      },
      ephemeral: true,
    });
  });

  it("posts a durable thought when authorization fails", async () => {
    const { events, fetch } = buildEvents();

    await events["authorization.completed"]!(
      {
        name: "notion",
        outcome: "timed-out",
        reason: "The challenge expired",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_0",
      },
      buildChannelStub(),
      sessionContext(),
    );

    expect(activityInput(fetch)).toEqual({
      agentSessionId: "agent_session_1",
      content: {
        body: "Notion authorization timed out (The challenge expired).",
        type: "thought",
      },
    });
  });
});
