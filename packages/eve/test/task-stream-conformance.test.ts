import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "../src/client/client.js";
import { defaultMessageReducer } from "../src/client/message-reducer.js";
import { deriveRunFacts } from "../src/evals/runner/derive-run-facts.js";
import { taskLifecycleViolations } from "../src/internal/testing/task-lifecycle.js";
import {
  deriveTaskStreamStates,
  parseTaskStream,
  TASK_STREAM_FIXTURE_VERSION,
  type TaskStreamFixtureManifest,
} from "../src/internal/testing/task-stream-fixtures.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
  type MessageStreamEvent,
  type TaskStartedStreamEvent,
} from "../src/protocol/message.js";
import { TASK_PROTOCOL_VERSION } from "../src/tasks/protocol.js";

// Replays the published task stream fixtures through eve's own stream
// consumers. The scenario suite keeps the fixtures in step with the runtime.

const FIXTURE_DIR = new URL(
  `../conformance/task-streams/v${TASK_STREAM_FIXTURE_VERSION}/`,
  import.meta.url,
);
const HOST = "https://agent.example";
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", FIXTURE_DIR), "utf8"),
) as TaskStreamFixtureManifest;
const fixtures = manifest.fixtures.map((fixture) => {
  const text = readFileSync(new URL(fixture.file, FIXTURE_DIR), "utf8");
  return { events: parseTaskStream(text), fixture, text };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function streamResponse(text: string, tailIndex: number): Response {
  return new Response(text, {
    headers: {
      "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
      [EVE_STREAM_TAIL_INDEX_HEADER]: String(tailIndex),
      [EVE_STREAM_VERSION_HEADER]: manifest.streamVersion,
    },
  });
}

function requestedPath(request: string | URL | Request): string {
  return new URL(request instanceof Request ? request.url : String(request)).pathname;
}

describe("published task stream fixtures", () => {
  it("are recorded with the current stream and task protocol versions", () => {
    expect(manifest.fixtureVersion).toBe(TASK_STREAM_FIXTURE_VERSION);
    expect(manifest.streamVersion).toBe(EVE_MESSAGE_STREAM_VERSION);
    expect(manifest.taskProtocolVersion).toBe(TASK_PROTOCOL_VERSION);
    expect(readdirSync(FIXTURE_DIR).toSorted()).toEqual(
      ["manifest.json", ...manifest.fixtures.map((fixture) => fixture.file)].toSorted(),
    );
    const types = new Set(fixtures.flatMap(({ events }) => events.map((event) => event.type)));
    expect([...types].filter((type) => type.startsWith("task.")).toSorted()).toEqual([
      "task.ended",
      "task.settled",
      "task.started",
    ]);
  });

  describe.each(fixtures)("$fixture.name", ({ events, fixture, text }) => {
    it("reads back unchanged through the client session stream", async () => {
      const paths: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
        paths.push(requestedPath(request));
        return streamResponse(text, events.length - 1);
      });

      const snapshot = await new Client({ host: HOST }).sessions
        .attach(fixture.sessionId)
        .snapshot();

      expect(paths).toEqual([`/eve/v1/session/${fixture.sessionId}/stream`]);
      expect(snapshot.events).toEqual(events);
    });

    it("derives the published task states", () => {
      expect(deriveTaskStreamStates(events)).toEqual(fixture.tasks);
    });

    it("keeps the task lifecycle contract", () => {
      expect(taskLifecycleViolations(events)).toEqual([]);
      const tasks = new Set(fixture.tasks.map((task) => task.taskId));
      const working = new Set<string>();
      const settled = new Set<string>();
      for (const event of events) {
        switch (event.type) {
          case "task.started":
            working.add(event.data.taskId);
            break;
          case "task.settled":
            expect(event.data.status === "failed").toBe(event.data.error !== undefined);
            expect(event.data.status === "completed").toBe("output" in event.data);
            working.delete(event.data.taskId);
            settled.add(event.data.taskId);
            break;
          case "message.received":
            if (event.data.kind === "task.result") {
              expect(event.data.taskIds?.length).toBeGreaterThan(0);
              for (const taskId of event.data.taskIds ?? []) {
                expect(settled.has(taskId)).toBe(true);
              }
            }
            break;
          case "action.result": {
            const output = event.data.result.output as { status?: unknown; taskId?: unknown };
            if (output !== null && typeof output === "object" && output.status === "working") {
              expect(tasks.has(String(output.taskId))).toBe(true);
            }
            break;
          }
          case "input.requested":
            if (event.data.taskId !== undefined) {
              expect(tasks.has(event.data.taskId)).toBe(true);
              expect(working.has(event.data.taskId)).toBe(true);
            }
            break;
        }
      }
      // Every recorded session ran its tasks to an outcome.
      expect([...working]).toEqual([]);
    });

    it("projects through the default message reducer", () => {
      const reducer = defaultMessageReducer();
      const data = events.reduce(
        (current, event: MessageStreamEvent) => reducer.reduce(current, event),
        reducer.initial(),
      );

      const userInputs = events.filter(
        (event) => event.type === "message.received" && event.data.kind === undefined,
      );
      const users = data.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(userInputs.length);
      const texts = data.messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      );
      expect(texts.some((text) => text.includes("<task_result"))).toBe(false);
    });

    it("derives eval facts for its agent calls", () => {
      const facts = deriveRunFacts(events, { sessionId: fixture.sessionId });
      expect(
        facts.subagentCalls
          .map(({ name, status, taskId }) => ({ name, status, taskId }))
          .toSorted((left, right) => String(left.taskId).localeCompare(String(right.taskId))),
      ).toEqual(
        fixture.tasks
          .filter((task) => task.kind === "agent")
          .map(({ name, status, taskId }) => ({ name, status, taskId })),
      );
    });

    it("follows each agent child with session.streamSubagent", async () => {
      const children = events.filter(
        (event): event is TaskStartedStreamEvent & MessageStreamEvent =>
          event.type === "task.started" && event.data.child !== undefined,
      );
      const paths: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
        paths.push(requestedPath(request));
        return streamResponse("", -1);
      });
      const session = new Client({ host: HOST }).sessions.attach(fixture.sessionId);

      for (const started of children) {
        for await (const _event of session.streamSubagent(started, { follow: false })) {
          // An empty child stream: only the route matters here.
        }
      }

      expect(paths).toEqual(children.map((started) => started.data.child!.streamPath));
    });
  });
});
