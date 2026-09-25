import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import type { ClientSession } from "../../src/client/index.js";
import type { MessageStreamEvent } from "../../src/protocol/message.js";
import {
  materializeScenarioApp,
  type ScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import { startEveDev, type RunningEveDev } from "./dev-server-harness.js";

// Two eve deployments talk through an in-process relay, which records their
// traffic and can drop a callback or answer as an older eve deployment.

const SCENARIO_TIMEOUT_MS = 480_000;
const ENV = { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" };
const REMOTE_TOKEN = "remote-tasks-scenario-token";
const LEDGER_TIMEOUT_MS = 8_000;

interface RecordedRequest {
  readonly body: string;
  readonly path: string;
}

interface Relay {
  readonly url: string;
  /** Callbacks the remote sent the parent, in order. */
  readonly callbacks: RecordedRequest[];
  /** Messages the parent sent existing remote sessions, in order. */
  readonly continues: RecordedRequest[];
  /** Requests the parent sent the impersonated older remote, as `METHOD path`. */
  readonly legacyRequests: string[];
  /** Drop the next result callback from this agent while answering the remote 202. */
  dropNextResultFrom: string | undefined;
  parentUrl: string;
  remoteUrl: string;
  close(): Promise<void>;
}

const PARENT_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const TASK_ID = /<task id="([^"]+)" tool="billing"/u;
const RECEIPT = /^(?:Started task|Sent to task) ([\\w-]+)[.,]/u;

// One call per user message, keyed by its id: a [Tasks] note may follow the result.
// A plan that waits reads its result with task_wait; the refund's arrives in its held turn.
const PLANS = {
  "Refund order 42 through billing.": { id: "refund-call", name: "billing", input: () => ({ message: "Refund order 42." }) },
  "Ask billing for the refund status.": {
    id: "status-call",
    name: "billing",
    input: (text) => ({ message: "What is the refund status?", taskId: TASK_ID.exec(text)?.[1] }),
    wait: true,
  },
  "Summarize the ledger.": { id: "ledger-call", name: "ledger", input: () => ({ message: "Summarize the ledger." }), wait: true },
  "Call the legacy billing agent.": { id: "legacy-call", name: "legacy", input: () => ({ message: "Hello from the parent." }), wait: true },
};

export default defineAgent({
  model: mockModel(({ lastUserMessage, messages, toolResults }) => {
    if (lastUserMessage?.startsWith("<task_result")) return "Result: " + lastUserMessage;
    const plan = PLANS[lastUserMessage ?? ""];
    if (plan === undefined) return "Unexpected: " + lastUserMessage;
    const waited = toolResults.find((candidate) => candidate.id === plan.id + "-wait");
    if (waited !== undefined) return "Result: " + JSON.stringify(waited.output);
    const result = toolResults.find((candidate) => candidate.id === plan.id);
    if (result === undefined) {
      const text = messages.map((message) => message.text).join("\\n");
      return { toolCalls: [{ id: plan.id, name: plan.name, input: plan.input(text) }] };
    }
    const taskId = RECEIPT.exec(String(result.output))?.[1];
    // A start that failed returns its error in place of a receipt.
    if (taskId === undefined) return "Result: " + JSON.stringify(result.output);
    if (plan.wait !== true) return "Started: " + taskId;
    return { toolCalls: [{ id: plan.id + "-wait", name: "task_wait", input: { taskId } }] };
  }),
  modelContextWindowTokens: 32_000,
});
`;

const REMOTE_AGENT = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, toolResults }) => {
    const refund = toolResults.find((result) => result.name === "refund");
    const note = toolResults.find((result) => result.name === "ask_question");
    if (lastUserMessage?.includes("Refund order 42.")) {
      if (refund === undefined) return { toolCalls: [{ name: "refund", input: { orderId: "42" } }] };
      if (note === undefined) {
        return {
          toolCalls: [
            {
              name: "ask_question",
              input: {
                question: "Should the refund confirmation include a note for Alice?",
                options: [
                  { label: "Add a note", description: "Include a short apology." },
                  { label: "No note", description: "Send the plain confirmation." },
                ],
              },
            },
          ],
        };
      }
      return "Refunded order 42 (" + JSON.stringify(refund.output) + "); note: " + JSON.stringify(note.output);
    }
    if (lastUserMessage?.includes("What is the refund status?")) return "Order 42 refund is complete.";
    if (lastUserMessage?.includes("Summarize the ledger.")) return "Ledger balanced at 1,204 entries.";
    return "OK";
  }),
  modelContextWindowTokens: 32_000,
});
`;

const REMOTE_CHANNEL = `import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth(request) {
    if (request.headers.get("authorization") !== "Bearer ${REMOTE_TOKEN}") return null;
    return { attributes: {}, authenticator: "scenario-bearer", principalId: "parent-app", principalType: "service" };
  },
});
`;

function remoteAgentSource(input: { readonly url: string; readonly timeout?: number }): string {
  return `import { defineRemoteAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineRemoteAgent({
  auth: bearer(${JSON.stringify(REMOTE_TOKEN)}),
  description: "Handles billing requests.",
  url: ${JSON.stringify(input.url)},${input.timeout === undefined ? "" : `\n  timeout: ${String(input.timeout)},`}
});
`;
}

describe("remote agents across two deployments", () => {
  let relay: Relay;
  let remote: RunningEveDev;
  let parent: RunningEveDev;
  const failures: string[] = [];
  // Both deployments serve every test, so their apps live until the suite ends.
  const apps: ScenarioApp[] = [];
  const scenarioApp = async (descriptor: ScenarioAppDescriptor) => {
    const app = await materializeScenarioApp(descriptor);
    apps.push(app);
    return app;
  };

  beforeAll(async () => {
    relay = await startRelay();
    const remoteApp = await scenarioApp({
      dependencies: { zod: "^4.3.6" },
      files: {
        "agent/agent.ts": REMOTE_AGENT,
        "agent/channels/eve.ts": REMOTE_CHANNEL,
        "agent/instructions.md": "Handle billing requests.\n",
        "agent/tools/ask_question.ts": `import { askQuestion } from "eve/tools/ask_question";\n\nexport default askQuestion();\n`,
        "agent/tools/refund.ts": `import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Refund an order once a person approves it.",
  inputSchema: z.object({ orderId: z.string() }),
  approval: once(),
  async execute({ orderId }) {
    return { orderId, refunded: true };
  },
});
`,
      },
      installDependencies: true,
      name: "remote-tasks-billing",
    });
    remote = await startEveDev(remoteApp.appRoot, { env: ENV });
    relay.remoteUrl = remote.url;

    const parentApp = await scenarioApp({
      files: {
        "agent/agent.ts": PARENT_AGENT,
        "agent/channels/eve.ts": `import { none } from "eve/channels/auth";\nimport { eveChannel } from "eve/channels/eve";\n\nexport default eveChannel({ auth: none() });\n`,
        "agent/instructions.md": "Delegate billing work.\n",
        "agent/subagents/billing.ts": remoteAgentSource({ url: relay.url }),
        "agent/subagents/ledger.ts": remoteAgentSource({
          timeout: LEDGER_TIMEOUT_MS,
          url: relay.url,
        }),
        "agent/subagents/legacy.ts": remoteAgentSource({ url: `${relay.url}/legacy` }),
      },
      installDependencies: true,
      name: "remote-tasks-parent",
    });
    parent = await startEveDev(parentApp.appRoot, { env: ENV });
    relay.parentUrl = parent.url;
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (failures.length > 0) {
      console.error(
        [
          `parent stdout:\n${parent?.stdout()}`,
          `parent stderr:\n${parent?.stderr()}`,
          `remote stdout:\n${remote?.stdout()}`,
          `remote stderr:\n${remote?.stderr()}`,
        ].join("\n\n"),
      );
    }
    await parent?.stop();
    await remote?.stop();
    await relay?.close();
    await Promise.all(apps.map((app) => app.cleanup().catch(() => {})));
  }, 120_000);

  const record = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      failures.push(name);
      throw error;
    }
  };

  it(
    "surfaces a remote child's approval and question to the parent's client and routes the answers back",
    () =>
      record("hitl", async () => {
        const client = new Client({ host: parent.url });
        const { session, response } = await client.sessions.create({
          message: "Refund order 42 through billing.",
        });
        const first = await response.result();
        expect(lastReply(first.events)).toMatch(/^Started: billing-/u);

        // The remote tool's approval reaches the parent's client while the turn
        // that started the task holds on it, attributed to the task.
        const asked = await followUntil(session, (events) => requestCount(events) === 1);
        const started = asked.find((event) => event.type === "task.started");
        const taskId = started?.type === "task.started" ? started.data.taskId : undefined;
        expect(started?.type === "task.started" && started.data.child?.remote).toBeDefined();
        const approval = inputRequest(asked);
        expect(approval).toMatchObject({ kind: "tool-approval", taskId });

        await session.respond([
          { optionId: approvalOption(approval), requestId: approval.requestId },
        ]);
        // Then the remote agent's own question, through the same route.
        const question = inputRequest(
          await followUntil(session, (events) => requestCount(events) === 2),
        );
        expect(question).toMatchObject({ kind: "question", taskId });

        await session.respond([
          { optionId: question.options[0]!.id, requestId: question.requestId },
        ]);
        // The result arrives in the same held turn.
        const delivered = await followUntil(session, (events) =>
          events.some(
            (event, index) =>
              event.type === "message.received" &&
              event.data.kind === "task.result" &&
              events.slice(index).some((later) => later.type === "turn.completed"),
          ),
        );
        const reply = lastReply(delivered);
        expect(reply).toContain("Refunded order 42");
        expect(reply).toContain("refunded");
        expect(reply).toContain("Add a note");
        expect(settledFor(await readAll(session), taskId)).toEqual([
          expect.objectContaining({ status: "completed" }),
        ]);

        // A repeated result callback is acknowledged and changes nothing.
        const callback = relay.callbacks.findLast((entry) =>
          entry.body.includes('"turn.completed"'),
        );
        expect(callback).toBeDefined();
        const repeat = await fetch(new URL(callback!.path, parent.url), {
          body: callback!.body,
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(repeat.status).toBe(202);
        await wait(1_500);
        expect(settledFor(await readAll(session), taskId)).toHaveLength(1);

        // Continuing the agent sends one keyed request; a resent copy is admitted once.
        const status = await (await session.send("Ask billing for the refund status.")).result();
        expect(lastReply(status.events)).toContain("Order 42 refund is complete.");
        const resent = relay.continues.findLast((entry) => entry.body.includes("refund status"));
        expect(JSON.parse(resent!.body)).toMatchObject({
          operationId: expect.any(String),
          taskProtocol: 1,
          turnPolicy: "queue",
        });
        const replay = await fetch(new URL(resent!.path, remote.url), {
          body: resent!.body,
          headers: { authorization: `Bearer ${REMOTE_TOKEN}`, "content-type": "application/json" },
          method: "POST",
        });
        expect(replay.status).toBe(202);
        await wait(3_000);
        const childSessionId =
          started?.type === "task.started" ? started.data.child?.sessionId : "";
        const childEvents = await readAll(
          new Client({ auth: { bearer: REMOTE_TOKEN }, host: remote.url }).sessions.attach(
            childSessionId!,
          ),
        );
        expect(
          childEvents.filter(
            (event) =>
              event.type === "message.received" && event.data.message.includes("refund status"),
          ),
        ).toHaveLength(1);

        // Once the parent session is gone, a late callback is a duplicate, never a 404.
        await session.reset();
        // The reset session winds down after the call returns; until then its owner ignores the repeat.
        let late: Response | undefined;
        for (const deadline = Date.now() + 20_000; Date.now() < deadline; await wait(500)) {
          late = await fetch(new URL(callback!.path, parent.url), {
            body: callback!.body,
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          if (late.status !== 202) break;
        }
        expect(late!.status).toBe(200);
        await expect(late!.json()).resolves.toEqual({ duplicate: true, ok: true });
      }),
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "recovers a lost result callback at the call's deadline with one read of the remote",
    () =>
      record("lost-callback", async () => {
        relay.dropNextResultFrom = "ledger";
        const client = new Client({ host: parent.url });
        const startedAt = Date.now();
        const { response } = await client.sessions.create({ message: "Summarize the ledger." });
        const result = await response.result();
        const elapsed = Date.now() - startedAt;

        expect(relay.dropNextResultFrom).toBeUndefined();
        const settled = result.events.find((event) => event.type === "task.settled");
        expect(settled?.data).toMatchObject({
          output: "Ledger balanced at 1,204 entries.",
          status: "completed",
        });
        expect(lastReply(result.events)).toContain("Ledger balanced at 1,204 entries.");
        // Nothing arrived until the deadline's reconciliation read the remote.
        expect(elapsed).toBeGreaterThanOrEqual(LEDGER_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(LEDGER_TIMEOUT_MS + 60_000);

        // The remote shows a report only to the holder of the callback it was sent to.
        const dropped = relay.callbacks.findLast((entry) => entry.body.includes('"ledger"'));
        const callbackToken = decodeURIComponent(dropped!.path.split("/").pop()!);
        const { callId, sessionId } = JSON.parse(dropped!.body) as {
          callId: string;
          sessionId: string;
        };
        const readReport = (headers: Record<string, string>) =>
          fetch(new URL(`/eve/v1/session/${sessionId}/reports/${callId}`, remote.url), {
            headers: { authorization: `Bearer ${REMOTE_TOKEN}`, ...headers },
          });
        const owned = await readReport({ "x-eve-callback-token": callbackToken });
        await expect(owned.json()).resolves.toMatchObject({
          report: { callId, kind: "turn.completed", output: "Ledger balanced at 1,204 entries." },
        });
        const foreign = await readReport({ "x-eve-callback-token": "eve:inbox:v1:someone-else" });
        await expect(foreign.json()).resolves.toMatchObject({ ok: true, report: null });
        expect((await readReport({})).status).toBe(400);
      }),
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "fails a start across mixed eve versions at once with START_FAILED, in both directions",
    () =>
      record("mixed-versions", async () => {
        const client = new Client({ host: parent.url });
        const startedAt = Date.now();
        const { response } = await client.sessions.create({
          message: "Call the legacy billing agent.",
        });
        const result = await response.result();

        const settled = result.events.find((event) => event.type === "task.settled");
        expect(settled?.data).toMatchObject({
          error: {
            code: "START_FAILED",
            message: expect.stringContaining(
              "reports no task protocol version (it runs an older eve)",
            ),
          },
          status: "failed",
        });
        expect(lastReply(result.events)).toContain(
          "Upgrade so both deployments use the same task protocol version.",
        );
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        // The parent read the version from the older remote's health route and
        // never created a session there, so none of its model or tools ran.
        expect(relay.legacyRequests).toEqual(["GET /legacy/eve/v1/health"]);

        // An older parent, which sends a callback without a version, is refused by this remote.
        const refused = await fetch(new URL("/eve/v1/session", remote.url), {
          body: JSON.stringify({
            callback: {
              callId: "call-1",
              subagentName: "billing",
              token: "old-parent-token",
              url: new URL("/eve/v1/callback/old-parent-token", parent.url).href,
            },
            message: "Hello from an older parent.",
          }),
          headers: { authorization: `Bearer ${REMOTE_TOKEN}`, "content-type": "application/json" },
          method: "POST",
        });
        expect(refused.status).toBe(409);
        await expect(refused.json()).resolves.toMatchObject({
          code: "TASK_PROTOCOL_MISMATCH",
          taskProtocol: 1,
        });
      }),
    SCENARIO_TIMEOUT_MS,
  );
});

interface SurfacedRequest {
  readonly kind: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly requestId: string;
  readonly taskId?: string;
}

function inputRequest(events: readonly MessageStreamEvent[]): SurfacedRequest {
  const event = events.findLast((candidate) => candidate.type === "input.requested");
  if (event?.type !== "input.requested") {
    throw new Error(`No input request; saw ${events.map((e) => e.type).join(", ")}`);
  }
  const request = event.data.requests[0]!;
  return {
    kind: request.kind,
    options: request.options ?? [],
    requestId: request.requestId,
    taskId: event.data.taskId,
  };
}

function approvalOption(request: SurfacedRequest): string {
  return request.options.find((option) => /approve|allow|yes/iu.test(option.id))?.id ?? "approve";
}

function lastReply(events: readonly MessageStreamEvent[]): string {
  const reply = events.findLast((event) => event.type === "message.completed");
  return reply?.type === "message.completed" ? (reply.data.message ?? "") : "";
}

function requestCount(events: readonly MessageStreamEvent[]): number {
  return events.filter((event) => event.type === "input.requested").length;
}

/** Follows the session's stream from its start until `done` holds. */
async function followUntil(
  session: Pick<ClientSession, "stream">,
  done: (events: readonly MessageStreamEvent[]) => boolean,
): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  const iterator = session.stream({ startIndex: 0 })[Symbol.asyncIterator]();
  const deadline = Date.now() + 120_000;
  try {
    while (!done(events)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out; saw ${events.map((e) => e.type).join(", ")}`);
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for stream events.")), remaining),
        ),
      ]);
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return events;
}

function settledFor(events: readonly MessageStreamEvent[], taskId: string | undefined) {
  return events.flatMap((event) =>
    event.type === "task.settled" && event.data.taskId === taskId ? [event.data] : [],
  );
}

async function readAll(session: Pick<ClientSession, "stream">): Promise<MessageStreamEvent[]> {
  const events: MessageStreamEvent[] = [];
  for await (const event of session.stream({ follow: false, startIndex: 0 })) events.push(event);
  return events;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startRelay(): Promise<Relay> {
  const relay: Omit<Relay, "url" | "close"> = {
    callbacks: [],
    continues: [],
    dropNextResultFrom: undefined,
    legacyRequests: [],
    parentUrl: "",
    remoteUrl: "",
  };
  let url = "";
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.statusCode = 502;
      res.end(String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const path = req.url ?? "/";
    if (path.startsWith("/legacy/")) return answerAsOlderEve(req.method ?? "GET", path, res);
    if (path.startsWith("/parent/")) {
      const target = path.slice("/parent".length);
      relay.callbacks.push({ body, path: target });
      const report = JSON.parse(body) as { kind?: string; subagentName?: string };
      if (
        relay.dropNextResultFrom !== undefined &&
        report.subagentName === relay.dropNextResultFrom &&
        report.kind === "turn.completed"
      ) {
        relay.dropNextResultFrom = undefined;
        return send(res, 202, JSON.stringify({ ok: true }));
      }
      return await forward(req, res, new URL(target, relay.parentUrl).href, body);
    }
    let forwarded = body;
    if (req.method === "POST" && body.length > 0) {
      const json = JSON.parse(body) as { callback?: { url: string } };
      if (json.callback !== undefined) {
        json.callback.url = `${url}/parent${new URL(json.callback.url).pathname}`;
        forwarded = JSON.stringify(json);
      }
      if (/^\/eve\/v1\/session\/[^/]+$/u.test(path))
        relay.continues.push({ body: forwarded, path });
    }
    await forward(req, res, new URL(path, relay.remoteUrl).href, forwarded);
  }

  function answerAsOlderEve(method: string, path: string, res: ServerResponse): void {
    relay.legacyRequests.push(`${method} ${path}`);
    // An older eve's health route reports no task protocol version.
    if (path === "/legacy/eve/v1/health") {
      return send(res, 200, JSON.stringify({ ok: true, status: "ready", workflowId: "legacy" }));
    }
    // It would accept a create without a version and start the turn at once.
    if (path === "/legacy/eve/v1/session") {
      return send(
        res,
        202,
        JSON.stringify({ ok: true, sessionId: "legacy-session", status: "accepted" }),
      );
    }
    send(res, 404, JSON.stringify({ ok: false }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return Object.assign(relay, {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    url,
  });
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: string,
  body: string,
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || ["connection", "content-length", "host"].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const upstream = await fetch(target, {
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    headers,
    method: req.method,
  });
  const text = await upstream.text();
  res.statusCode = upstream.status;
  for (const name of ["content-type", "x-eve-task-protocol"]) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
  res.end(text);
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
