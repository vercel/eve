import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttachSessionFn } from "#channel/session.js";
import { createSessionStreamResponse } from "#eve-channel/request.js";
import { readSessionEvents } from "#execution/read-session-events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";

const REMOTE = { name: "researcher", url: "https://remote.example/agents/researcher" };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Serves sessions from this runtime as a remote agent's deployment would. */
function serveAsRemote(options: { readonly withoutTailIndex?: boolean } = {}): string[] {
  const attachSession = createAttachSessionFn(
    createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  );
  const requested: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    requested.push(`${url.pathname}${url.search}`);
    const match = /^\/agents\/researcher\/eve\/v1\/session\/([^/]+)\/stream$/u.exec(url.pathname);
    if (url.origin !== "https://remote.example" || match?.[1] === undefined) {
      return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
    }
    const response = await createSessionStreamResponse(
      new Request(url),
      attachSession(decodeURIComponent(match[1])),
    );
    // A receiver that predates `includeTailIndex`, or a proxy that drops the header.
    if (options.withoutTailIndex) response.headers.delete(EVE_STREAM_TAIL_INDEX_HEADER);
    return response;
  });
  return requested;
}

describe("readSessionEvents", () => {
  it("reads a parked session's stream in bounded pages without waiting for new events", async () => {
    const runtime = await createTestRuntime({ agent: { name: "read-session-events" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Say hello." },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:read-session-events",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const turn = await stream.nextTurn();
        expect(turn.at(-1)?.type).toBe("session.waiting");

        const first = await readSessionEvents({ limit: 2, sessionId: run.runId, startIndex: 0 });
        expect(first).toMatchObject({ caughtUp: false, nextIndex: 2 });
        expect(first.events.map((event) => event.type)).toEqual(
          turn.slice(0, 2).map((event) => event.type),
        );

        const rest = await readSessionEvents({
          limit: 1_000,
          sessionId: run.runId,
          startIndex: first.nextIndex,
        });
        expect(rest).toMatchObject({ caughtUp: true, nextIndex: turn.length });
        expect(rest.events.map((event) => event.type)).toEqual(
          turn.slice(2).map((event) => event.type),
        );

        // The session is parked: reading at its tail returns at once instead of following it.
        await expect(
          readSessionEvents({ limit: 1_000, sessionId: run.runId, startIndex: rest.nextIndex }),
        ).resolves.toEqual({ caughtUp: true, events: [], nextIndex: turn.length });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("reads a remote agent's parked session from its deployment in bounded pages", async () => {
    const runtime = await createTestRuntime({ agent: { name: "read-remote-session-events" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Say hello." },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:read-remote-session-events",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const turn = await stream.nextTurn();
        const requested = serveAsRemote();

        const first = await readSessionEvents({
          limit: 2,
          remote: REMOTE,
          sessionId: run.runId,
          startIndex: 0,
        });
        expect(first).toMatchObject({ caughtUp: false, nextIndex: 2 });
        const rest = await readSessionEvents({
          limit: 1_000,
          remote: REMOTE,
          sessionId: run.runId,
          startIndex: first.nextIndex,
        });
        expect(rest).toMatchObject({ caughtUp: true, nextIndex: turn.length });
        expect([...first.events, ...rest.events]).toEqual(turn);
        await expect(
          readSessionEvents({
            limit: 1_000,
            remote: REMOTE,
            sessionId: run.runId,
            startIndex: rest.nextIndex,
          }),
        ).resolves.toEqual({ caughtUp: true, events: [], nextIndex: turn.length });
        expect(requested[1]).toBe(
          `/agents/researcher/eve/v1/session/${run.runId}/stream?startIndex=2&includeTailIndex=1`,
        );

        await expect(
          readSessionEvents({
            limit: 1_000,
            remote: { ...REMOTE, url: "https://remote.example/agents/retired" },
            sessionId: run.runId,
            startIndex: 0,
          }),
        ).rejects.toThrow('Remote agent "researcher" session stream read failed with HTTP 404.');

        vi.restoreAllMocks();
        serveAsRemote({ withoutTailIndex: true });
        await expect(
          readSessionEvents({ limit: 1_000, remote: REMOTE, sessionId: run.runId, startIndex: 0 }),
        ).rejects.toThrow(
          'Remote agent "researcher" session stream did not report its tail index.',
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
