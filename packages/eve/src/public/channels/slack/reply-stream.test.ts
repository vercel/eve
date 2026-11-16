import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { slackRenderingHarness } from "#internal/testing/slack-rendering-harness.js";
import {
  defineSlackRenderer,
  slackChannel,
  type SlackChannelConfig,
  type SlackChannelState,
} from "#public/channels/slack/index.js";

const THREAD_TS = "1700000000.000001";
const STREAM_TS = "1700000002.000001";
const LONG = "A reply that keeps going. ".repeat(12);

let fetchMock: ReturnType<typeof vi.fn>;
let refused: Record<string, string>;
let limited: Set<string>;
let now: number;

beforeEach(() => {
  refused = {};
  limited = new Set();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetchMock = vi.fn(async (request: string | URL | Request) => {
    const operation = String(request).replace("https://slack.com/api/", "");
    if (limited.has(operation)) {
      return Response.json({ ok: false, error: "ratelimited" }, { status: 429 });
    }
    const error = refused[operation];
    if (error !== undefined) return Response.json({ ok: false, error });
    return Response.json({ ok: true, ts: operation === "chat.startStream" ? STREAM_TS : "1.1" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Slack calls in order, as `operation` and decoded body, skipping status updates. */
function calls(): Array<[string, Record<string, unknown>]> {
  return fetchMock.mock.calls
    .map(([url, init]) => {
      const { body, headers } = (init ?? {}) as RequestInit;
      const contentType = headers ? new Headers(headers).get("content-type") : null;
      return [
        String(url).replace("https://slack.com/api/", ""),
        (body ? decodeSlackApiBody(body, contentType) : {}) as Record<string, unknown>,
      ] as [string, Record<string, unknown>];
    })
    .filter(([operation]) => operation !== "assistant.threads.setStatus");
}

function operations(): string[] {
  return calls().map(([operation]) => operation);
}

function harness(
  config: SlackChannelConfig = { experimental: { streaming: true } },
  state: Partial<SlackChannelState> = {},
) {
  const channel = slackChannel({ credentials: { botToken: "xoxb-test" }, ...config });
  const rendering = slackRenderingHarness(channel, {
    channelId: "C01",
    teamId: "T01",
    threadTs: THREAD_TS,
    triggeringUserId: "U01",
    ...state,
  });
  const scope = { runId: "r1", turnId: "t1" };
  let announced = false;
  return {
    ...rendering,
    async start() {
      await rendering.step("turn");
      await rendering.step("model");
    },
    async write(text: string, partId = "p1") {
      await rendering.event({
        type: "content.delta",
        data: { delta: text, partId, ...(!announced && { kind: "text" }) },
        scope,
      });
      announced = true;
    },
    async settleRun(finishReason = "stop") {
      await rendering.event({
        type: "model.settled",
        data: { finishReason, outcome: "completed", runId: "r1" },
        scope,
      });
    },
    async complete(value: string, phase: "reply" | "narration" = "reply", partId = "p1") {
      await rendering.event({
        type: "content.completed",
        data: { kind: "text", partId, phase, runId: "r1", value },
        scope,
      });
      announced = false;
    },
  };
}

describe("Slack reply streaming", () => {
  it("streams a long reply into the thread and closes it with the rest", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    now += 1_500;
    await write(" More.");
    await write(" Done.");
    await complete(`${LONG} More. Done.`);

    expect(calls()).toEqual([
      ["chat.getPermalink", expect.anything()],
      [
        "chat.startStream",
        {
          channel: "C01",
          markdown_text: LONG,
          recipient_team_id: "T01",
          recipient_user_id: "U01",
          thread_ts: THREAD_TS,
        },
      ],
      ["chat.appendStream", { channel: "C01", markdown_text: " More.", ts: STREAM_TS }],
      ["chat.stopStream", { channel: "C01", markdown_text: " Done.", ts: STREAM_TS }],
    ]);
  });

  it("posts a short reply whole", async () => {
    const { complete, start, write } = harness();
    await start();

    await write("Sunny.");
    await complete("Sunny.");

    expect(operations()).toEqual(["chat.getPermalink", "chat.postMessage"]);
  });

  it("removes streamed text that turns out to be narration", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    await complete(LONG, "narration");

    expect(operations()).toEqual([
      "chat.getPermalink",
      "chat.startStream",
      "chat.stopStream",
      "chat.delete",
    ]);
  });

  it("rewrites the streamed message when a renderer changes the reply", async () => {
    const signed = defineSlackRenderer({
      events: {
        "content.delta": (event, _ctx, next) => next(event),
        async "content.completed"(event, _ctx, next) {
          const { value } = event.data;
          await next({ ...event, data: { ...event.data, value: `${String(value)}\n\n— eve` } });
        },
      },
    });
    const { complete, start, write } = harness({
      experimental: { streaming: true },
      renderers: [signed],
    });
    await start();

    await write(LONG);
    await complete(LONG.replace("A reply", "The reply"));

    const [stop, update] = calls().slice(-2);
    expect(stop).toEqual(["chat.stopStream", { channel: "C01", ts: STREAM_TS }]);
    expect(update?.[0]).toBe("chat.update");
    expect(update?.[1]).toMatchObject({
      blocks: [{ type: "markdown", text: `${LONG.replace("A reply", "The reply")}\n\n— eve` }],
      ts: STREAM_TS,
    });
    expect(operations()).not.toContain("chat.postMessage");
  });

  it("posts replies whole while a renderer changes them only once completed", async () => {
    const redacting = defineSlackRenderer({
      events: {
        async "content.completed"(event, _ctx, next) {
          const value = String(event.data.value).replaceAll("keeps", "[redacted]");
          await next({ ...event, data: { ...event.data, value } });
        },
      },
    });
    const { complete, start, write } = harness({
      experimental: { streaming: true },
      renderers: [redacting],
    });
    await start();

    await write(LONG);
    await complete(LONG);

    expect(operations()).toEqual(["chat.getPermalink", "chat.postMessage"]);
  });

  it("streams what a renderer's content.delta passes on", async () => {
    const redacting = defineSlackRenderer({
      events: {
        "content.delta": (event, _ctx, next) =>
          next({
            ...event,
            data: { ...event.data, delta: event.data.delta.replaceAll("keeps", "[redacted]") },
          }),
        async "content.completed"(event, _ctx, next) {
          const value = String(event.data.value).replaceAll("keeps", "[redacted]");
          await next({ ...event, data: { ...event.data, value } });
        },
      },
    });
    const { complete, start, write } = harness({
      experimental: { streaming: true },
      renderers: [redacting],
    });
    await start();

    await write(LONG);
    await complete(LONG);

    const redacted = LONG.replaceAll("keeps", "[redacted]");
    expect(calls().slice(1)).toEqual([
      ["chat.startStream", expect.objectContaining({ markdown_text: redacted })],
      ["chat.stopStream", { channel: "C01", ts: STREAM_TS }],
    ]);
  });

  it("removes a part its model run never completed", async () => {
    const { settleRun, start, write } = harness();
    await start();

    await write(LONG);
    await settleRun("content-filter");

    expect(operations().slice(-3)).toEqual(["chat.startStream", "chat.stopStream", "chat.delete"]);
  });

  it("waits longer and keeps streaming when Slack rate-limits an append", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    limited.add("chat.appendStream");
    now += 1_500;
    await write(" One.");
    limited.delete("chat.appendStream");
    now += 1_500;
    await write(" Two.");
    now += 1_000;
    await write(" Three.");
    await complete(`${LONG} One. Two. Three.`);

    expect(calls().slice(2)).toEqual([
      ["chat.appendStream", expect.objectContaining({ markdown_text: " One." })],
      ["chat.appendStream", expect.objectContaining({ markdown_text: " One. Two. Three." })],
      ["chat.stopStream", { channel: "C01", ts: STREAM_TS }],
    ]);
  });

  it("doesn't stream a quiet turn's text", async () => {
    const { complete, start, write } = harness(undefined, { pendingQuietTurn: true });
    await start();

    await write(LONG);
    await complete(LONG);

    expect(operations()).not.toContain("chat.startStream");
  });

  it("finishes a stream whose appends failed by rewriting the message", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    refused["chat.appendStream"] = "message_not_in_streaming_state";
    now += 1_500;
    await write(" More.");
    await complete(`${LONG} More.`);

    expect(operations().slice(-3)).toEqual(["chat.appendStream", "chat.stopStream", "chat.update"]);
  });

  it("still posts the reply when Slack won't rewrite or remove the streamed message", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    refused["chat.appendStream"] = "internal_error";
    refused["chat.update"] = "internal_error";
    refused["chat.delete"] = "internal_error";
    now += 1_500;
    await write(" More.");
    await complete(`${LONG} More.`);

    expect(operations().slice(-4)).toEqual([
      "chat.stopStream",
      "chat.update",
      "chat.delete",
      "chat.postMessage",
    ]);
  });

  it("leaves a reply someone stopped in Slack as it was", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    refused["chat.appendStream"] = "stopped_by_user";
    now += 1_500;
    await write(" More.");
    await complete(`${LONG} More.`);

    expect(operations().slice(-1)).toEqual(["chat.appendStream"]);
  });

  it("leaves a reply someone stopped after its last append as it was", async () => {
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    refused["chat.stopStream"] = "message_not_in_streaming_state";
    await complete(`${LONG} More.`);

    expect(operations().slice(-2)).toEqual(["chat.startStream", "chat.stopStream"]);
  });

  it("posts the reply whole when Slack won't start a stream", async () => {
    refused["chat.startStream"] = "unknown_method";
    const { complete, start, write } = harness();
    await start();

    await write(LONG);
    await complete(LONG);

    expect(operations().slice(1)).toEqual([
      "chat.startStream",
      "chat.getPermalink",
      "chat.postMessage",
    ]);
  });

  it("doesn't stream without the person the reply is for", async () => {
    const { complete, start, write } = harness(undefined, { triggeringUserId: null });
    await start();

    await write(LONG);
    await complete(LONG);

    expect(operations()).toEqual(["chat.getPermalink", "chat.postMessage"]);
  });

  it("streams a code channel's reply top-level, without a thread", async () => {
    const { complete, start, write } = harness(
      { codeChannels: true, experimental: { streaming: true } },
      { codeChannel: true, threadTs: null },
    );
    await start();

    await write(LONG);
    await complete(LONG);

    const [started] = calls().filter(([operation]) => operation === "chat.startStream");
    expect(started?.[1]).not.toHaveProperty("thread_ts");
    expect(started?.[1]).toMatchObject({ recipient_user_id: "U01" });
  });

  it("is off by default", async () => {
    const { complete, start, write } = harness({});
    await start();

    await write(LONG);
    await complete(LONG);

    expect(operations()).toEqual(["chat.getPermalink", "chat.postMessage"]);
  });

  it("drops a stream the turn never delivered", async () => {
    const { start, step, write } = harness();
    await start();

    await write(LONG);
    await step("end");

    expect(operations().slice(-2)).toEqual(["chat.stopStream", "chat.delete"]);
  });
});
