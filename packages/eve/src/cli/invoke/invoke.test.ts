import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInvokeOperation, runInvoke, type RunInvokeInput } from "./invoke.js";
import { parseInvokeResumeInput } from "./result.js";

const cursor = {
  sessionId: "ses_1",
  streamIndex: 3,
};
const target = { kind: "remote" as const, serverUrl: "https://example.com/" };
const localTarget = {
  kind: "local" as const,
  serverUrl: "https://example.com/",
  workspaceRoot: "/repo",
};
const resume = { session: cursor, target };
const request = {
  action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "bash" },
  kind: "tool-approval" as const,
  display: "confirmation" as const,
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  prompt: "Approve?",
  requestId: "approval-1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseInvokeResumeInput", () => {
  it("accepts a complete result containing durable session coordinates", () => {
    const result = { status: "running" as const, resume };
    expect(parseInvokeResumeInput(result)).toEqual(result);
  });

  it("rejects standalone capsules, malformed results, and non-resumable results", () => {
    expect(() => parseInvokeResumeInput(resume)).toThrow("valid resumable eve invoke result");
    expect(() =>
      parseInvokeResumeInput({ status: "running", resume: { ...resume, session: {} } }),
    ).toThrow("valid resumable eve invoke result");
    expect(() => parseInvokeResumeInput({ status: "failed", message: "boom" })).toThrow(
      "valid resumable eve invoke result",
    );
  });
});

describe("runInvoke", () => {
  it("preserves an accepted session when its stream later rejects authorization", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ sessionId: "ses_1" }, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            code: "unauthorized",
            error: "Authorization is required for this route.",
          },
          { status: 401 },
        ),
      );

    await expect(
      runInvoke({
        headers: { authorization: "Bearer explicit" },
        operation: { kind: "send", payload: { message: "do foo" } },
        target: { ...target, workspaceRoot: "/repo" },
      }),
    ).resolves.toMatchObject({
      status: "authentication-required",
      resume: { session: { sessionId: "ses_1" } },
    });
  });

  it("reduces a blocking input event into one resumable result", async () => {
    const result = await runStreamedInvocation([
      { type: "input.requested", data: { requests: [request] } },
      {
        type: "session.waiting",
        data: { wait: "next-user-message" },
      },
    ]);

    expect(result).toMatchObject({
      status: "input-required",
      requests: [
        {
          options: request.options,
          prompt: request.prompt,
          requestId: request.requestId,
        },
      ],
      resume: {
        session: { sessionId: "ses_1", streamIndex: 2 },
      },
    });
    if (result.status !== "input-required") throw new Error("Expected input-required result.");
    expect(result.requests[0]).not.toHaveProperty("action");
    expect(result.requests[0]).not.toHaveProperty("display");
  });

  it("returns a ready snapshot when a recoverable turn parks the session", async () => {
    await expect(
      runStreamedInvocation([
        {
          type: "turn.failed",
          data: { code: "provider_error", message: "Model unavailable" },
        },
        {
          type: "session.waiting",
          data: { wait: "next-user-message" },
        },
      ]),
    ).resolves.toMatchObject({
      status: "ready",
      outcome: { status: "failed", message: "Model unavailable" },
      resume: {
        session: { sessionId: "ses_1", streamIndex: 2 },
      },
    });
  });

  it("parks remote authorization at its durable boundary before returning", async () => {
    await expect(
      runStreamedInvocation(
        [
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "linear", webhookUrl: "https://auth.test" },
          },
          {
            type: "session.waiting",
            data: { wait: "next-user-message" },
          },
        ],
        {
          target: { ...target, workspaceRoot: "/repo" },
          headers: { authorization: "Bearer explicit" },
        },
      ),
    ).resolves.toMatchObject({
      status: "authorization-required",
      authorizations: [{ name: "linear" }],
      resume: { session: { sessionId: "ses_1", streamIndex: 2 } },
    });
  });

  it("returns every pending remote authorization", async () => {
    await expect(
      runStreamedInvocation(
        [
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "linear", webhookUrl: "https://linear.test" },
          },
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "github", webhookUrl: "https://github.test" },
          },
          {
            type: "session.waiting",
            data: { wait: "next-user-message" },
          },
        ],
        {
          target: { ...target, workspaceRoot: "/repo" },
          headers: { authorization: "Bearer explicit" },
        },
      ),
    ).resolves.toMatchObject({
      status: "authorization-required",
      authorizations: [{ name: "linear" }, { name: "github" }],
    });
  });

  it("rejects authorization that depends on a temporary local callback server", async () => {
    await expect(
      runStreamedInvocation([
        {
          type: "authorization.required",
          data: {
            description: "Sign in",
            name: "linear",
            webhookUrl: "http://127.0.0.1:2000/eve/v1/connections/linear/callback/hook",
          },
        },
        {
          type: "session.waiting",
          data: { wait: "next-user-message" },
        },
      ]),
    ).resolves.toEqual({
      status: "failed",
      message:
        "Local eve invoke cannot pause for connection authorization because its temporary server must remain available for the callback. Run eve dev, then invoke its URL with --url.",
    });
  });

  it("does not preserve authorization after its completion event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamResponse([
        { type: "authorization.completed", data: { name: "linear", outcome: "authorized" } },
        {
          type: "message.completed",
          data: { finishReason: "stop", message: "done" },
        },
        {
          type: "session.waiting",
          data: { wait: "next-user-message" },
        },
      ]),
    );

    await expect(
      runInvoke({
        operation: { kind: "follow", resume },
        target: { ...target, workspaceRoot: "/repo" },
        headers: { authorization: "Bearer explicit" },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      outcome: { status: "completed", message: "done" },
    });
  });
});

describe("resolveInvokeOperation", () => {
  it("starts an invocation from a prompt", () => {
    expect(resolveInvokeOperation({ prompt: "do foo" })).toEqual({
      kind: "send",
      payload: { message: "do foo" },
    });
  });

  it("forwards input response text for the harness to resolve against pending requests", () => {
    const previous = parseInvokeResumeInput({
      status: "input-required",
      requests: [
        {
          kind: request.kind,
          options: request.options,
          prompt: request.prompt,
          requestId: request.requestId,
        },
        {
          kind: request.kind,
          options: request.options,
          prompt: request.prompt,
          requestId: "approval-2",
        },
      ],
      resume,
    });
    expect(resolveInvokeOperation({ previous, prompt: "Approve" })).toEqual({
      kind: "send",
      resume,
      payload: { message: "Approve" },
    });
  });

  it("sends a follow-up to a ready invocation", () => {
    const previous = parseInvokeResumeInput({
      status: "ready",
      outcome: { status: "completed", message: "done" },
      resume,
    });
    expect(resolveInvokeOperation({ previous, prompt: "follow up" })).toEqual({
      kind: "send",
      payload: { message: "follow up" },
      resume,
    });
  });

  it("rejects follow-up prompts for terminal invocation snapshots", () => {
    expect(() =>
      resolveInvokeOperation({
        previous: {
          status: "failed",
          message: "terminal",
          resume,
        },
        prompt: "retry",
      }),
    ).toThrow("terminal failed invocation cannot be resumed");
  });

  it("follows authorization without posting another turn", () => {
    const previous = parseInvokeResumeInput({
      status: "authorization-required",
      authorizations: [{ description: "Sign in", name: "linear" }],
      resume,
    });
    expect(resolveInvokeOperation({ previous })).toEqual({ kind: "follow", resume });
  });
});

async function runStreamedInvocation(
  events: readonly unknown[],
  overrides: Partial<RunInvokeInput> = {},
): Promise<Awaited<ReturnType<typeof runInvoke>>> {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ sessionId: "ses_1" }, { status: 202 }))
    .mockResolvedValueOnce(streamResponse(events));
  return runInvoke({
    operation: { kind: "send", payload: { message: "do foo" } },
    target: localTarget,
    ...overrides,
  });
}

function streamResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    }),
  );
}
