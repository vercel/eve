import { describe, expect, it } from "vitest";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import {
  buildSerializedContext,
  createWeatherAuthRuntime,
  authorizationAttemptId,
  expectSingleTurn,
  captureEvents,
  expectHookClaims,
} from "#internal/testing/entry-test-helpers.js";

describe("workflowEntry integration", () => {
  it("resumes normal follow-ups after an interactive authorization callback", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-followup",
    );
    const continuationToken = "http:workflow-entry-auth-followup";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        const required = filterEventsByType(firstTurn, "authorization.required");

        expect(firstTurn.at(-1)?.type).toBe("authorization.required");
        expect(required).toHaveLength(1);
        expect(required[0]?.data).toMatchObject({
          name: "weather",
          authorization: { displayName: "Weather" },
        });

        // The authorization park closes its turn boundary so stream
        // consumers do not hang on the parked turn.
        const parkBoundary = await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );
        expect(parkBoundary.at(-1)?.type).toBe("session.waiting");
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId), continuationToken]);

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: {
                  method: "GET",
                  params: { code: "oauth-code" },
                },
                connectionName: "weather",
              },
            },
          ],
        });

        const authorizedTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(authorizedTurn, "authorization.completed");

        expect(completeCalls()).toBe(1);
        expectSingleTurn(authorizedTurn, "turn_1");
        expect(authorizedTurn.at(-1)?.type).toBe("session.waiting");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });
        expect(
          authorizedTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Used local weather tool for Lisbon") === true,
          ),
        ).toBe(true);

        await waitForHook(
          { runId: run.runId },
          {
            token: sessionInboxHookToken(continuationToken),
          },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "follow up after auth" },
        });

        const followupTurn = await stream.nextUntil(
          "post-auth follow-up turn",
          (event) => event.type === "session.waiting",
        );

        expect(followupTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          followupTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after auth") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("runs ordinary deliveries while an authorization challenge stays open", async () => {
    const { completeCalls, completedPrincipals, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-open",
    );
    const continuationToken = "http:workflow-entry-auth-open";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        // Consume the park's own turn boundary so the next wait delimits
        // the intervening message turn.
        await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );

        // An ordinary message while the challenge is open runs as a normal
        // turn instead of queueing behind the callback.
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-2",
            principalType: "user",
          },
          kind: "send",
          payload: { message: "Quick status note while I sign in." },
        });

        const interveningTurn = await stream.nextUntil(
          "intervening message turn",
          (event) => event.type === "session.waiting",
        );
        expect(
          interveningTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Quick status note while I sign in.") === true,
          ),
        ).toBe(true);
        expect(filterEventsByType(interveningTurn, "authorization.completed")).toHaveLength(0);
        expect(completeCalls()).toBe(0);

        // The callback still lands on the retained read and closes the
        // challenge exactly once.
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: {
                  method: "GET",
                  params: { code: "oauth-code" },
                },
                connectionName: "weather",
              },
            },
          ],
        });

        const callbackTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(callbackTurn, "authorization.completed");
        expectSingleTurn(callbackTurn, "turn_2");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });

        // The granted authorization serves the next explicit tool request.
        // (No waitForHook here: it only reports never-received hooks, and
        // the continuation hook already received the intervening message.)
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-1",
            principalType: "user",
          },
          kind: "send",
          payload: { message: "Use the get_weather tool to check the weather in Lisbon." },
        });

        const toolTurn = await stream.nextUntil(
          "post-authorization tool turn",
          (event) => event.type === "session.waiting",
        );
        expect(completeCalls()).toBe(1);
        expect(completedPrincipals()).toEqual([
          expect.objectContaining({ id: "user-1", type: "user" }),
        ]);
        expect(
          toolTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Used local weather tool for Lisbon") === true &&
              event.data.message.includes("authorized with weather-token"),
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("defers ordinary deliveries while a task waits for authorization", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-task-auth-open",
    );
    const continuationToken = "http:workflow-entry-task-auth-open";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "task",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial task auth-required event",
          (event) => event.type === "authorization.required",
        );

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "This must not become a second task turn." },
        });
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: "weather",
              },
            },
          ],
        });

        const completion = await stream.nextUntil(
          "authorized task completion",
          (event) => event.type === "session.completed",
        );
        const allEvents = [...firstTurn, ...completion];
        expect(filterEventsByType(allEvents, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "message.received")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "authorization.completed")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "session.waiting")).toHaveLength(0);
        expect(completeCalls()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ignores stale and duplicate callbacks after a challenge is replaced", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-replaced",
    );
    const continuationToken = "http:workflow-entry-auth-replaced";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstAttempt = await stream.nextUntil(
          "first auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil(
          "first authorization park",
          (event) => event.type === "session.waiting",
        );

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "Use the get_weather tool to check the weather in Lisbon." },
        });
        const replacementAttempt = await stream.nextUntil(
          "replacement auth-required event",
          (event) => event.type === "authorization.required",
        );
        expect(filterEventsByType(replacementAttempt, "authorization.completed")).toMatchObject([
          { data: { name: "weather", outcome: "failed" } },
        ]);
        await stream.nextUntil(
          "replacement authorization park",
          (event) => event.type === "session.waiting",
        );

        const stalePayload = {
          authorizationCallback: {
            attemptId: authorizationAttemptId(firstAttempt),
            callback: { method: "GET", params: { code: "stale-oauth-code" } },
            connectionName: "weather",
          },
        };
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [stalePayload],
        });
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [stalePayload],
        });

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(replacementAttempt),
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: "weather",
              },
            },
          ],
        });

        const callbackTurn = await stream.nextUntil(
          "replacement authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(callbackTurn, "authorization.completed")).toHaveLength(1);
        expect(completeCalls()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes the challenge after a no-op cancel consumed the parked wait", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-cancel");
    const continuationToken = "http:workflow-entry-auth-cancel";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );

        await waitForParkedTurnStep(run.runId);

        // A cancel with no active turn is consumed by the parked wait
        // without producing a parent turn. The callback must still surface
        // in the continued wait instead of stalling until unrelated
        // session activity re-parks the owner.
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), { kind: "cancel" });
        // Let the owner consume the no-op cancel and re-enter the parked
        // wait before the callback fires; back-to-back resumes could
        // otherwise surface the callback in the first wait iteration and
        // mask a wait that ignores callbacks after a consumed cancel.
        await new Promise((resolve) => setTimeout(resolve, 250));

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: {
                  method: "GET",
                  params: { code: "oauth-code" },
                },
                connectionName: "weather",
              },
            },
          ],
        });

        const callbackTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(callbackTurn, "authorization.completed");

        expect(completeCalls()).toBe(1);
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });
        expect(filterEventsByType(callbackTurn, "turn.cancelled")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
