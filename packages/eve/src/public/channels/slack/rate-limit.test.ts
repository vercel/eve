import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSlack, type MockSlack } from "#internal/testing/mocks/mock-slack.js";
import { buildSlackBinding } from "#public/channels/slack/api.js";
import {
  callSlackApi,
  callSlackApiJson,
  SlackApiError,
} from "#public/channels/slack/api-transport.js";
import { createSlackFetchFile } from "#public/channels/slack/attachments.js";
import { withSlackRateLimitRetry } from "#public/channels/slack/rate-limit.js";

const API_URL = "https://slack.test/api/";

/** Collects the waits a retry asked for without actually sleeping. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

function rateLimited(retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
    headers,
    status: 429,
  });
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("withSlackRateLimitRetry", () => {
  it("replays a 429 after the delay Retry-After asks for", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValueOnce(rateLimited("2")).mockResolvedValueOnce(ok());

    const response = await withSlackRateLimitRetry(upstream, { sleep })("https://slack.test/api/x");

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2_000]);
  });

  it("passes a successful response straight through", async () => {
    const upstream = vi.fn().mockResolvedValue(ok());

    const response = await withSlackRateLimitRetry(upstream)("https://slack.test/api/x");

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("does not replay a 5xx, which may have been applied before the response was lost", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));

    const response = await withSlackRateLimitRetry(upstream, { sleep })("https://slack.test/api/x");

    expect(response.status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("gives up after the attempt budget and returns the last 429", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValue(rateLimited("1"));

    const response = await withSlackRateLimitRetry(upstream, { maxAttempts: 3, sleep })(
      "https://slack.test/api/x",
    );

    expect(response.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("makes a single attempt when retries are disabled", async () => {
    const upstream = vi.fn().mockResolvedValue(rateLimited("1"));

    const response = await withSlackRateLimitRetry(upstream, { maxAttempts: 1 })(
      "https://slack.test/api/x",
    );

    expect(response.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("surfaces the rate limit instead of sleeping past the delay budget", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValue(rateLimited("120"));

    const response = await withSlackRateLimitRetry(upstream, { maxDelayMs: 30_000, sleep })(
      "https://slack.test/api/x",
    );

    expect(response.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("falls back to a fixed delay when a 429 carries no Retry-After", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(ok());

    const response = await withSlackRateLimitRetry(upstream, { sleep })("https://slack.test/api/x");

    expect(response.status).toBe(200);
    expect(waits).toEqual([1_000]);
  });

  it("does not guess a delay from an unparseable Retry-After", async () => {
    const { sleep, waits } = recordingSleep();
    const upstream = vi.fn().mockResolvedValue(rateLimited("Wed, 21 Oct 2026 07:28:00 GMT"));

    const response = await withSlackRateLimitRetry(upstream, { sleep })("https://slack.test/api/x");

    expect(response.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("reads the global fetch per request so a later stub is still honored", async () => {
    const { sleep } = recordingSleep();
    const retrying = withSlackRateLimitRetry(undefined, { sleep });
    const upstream = vi.fn().mockResolvedValueOnce(rateLimited("0")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", upstream);

    try {
      const response = await retrying("https://slack.test/api/x");
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** Stubs the three legs of the external upload handshake. */
function allowUpload(slack: MockSlack, fileId = "F1"): void {
  slack
    .allow("files.getUploadURLExternal")
    .andReturn({ ok: true, upload_url: slack.uploadUrl(fileId), file_id: fileId });
  slack
    .allow("files.completeUploadExternal")
    .andRespond((body) => ({ ok: true, files: body.files }));
}

describe("Slack transport rate limiting", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack({ url: API_URL });
  });
  afterEach(() => {
    slack.assertNoViolations();
  });

  it("replays a form-encoded call and returns the Slack response it eventually gets", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    slack.failNextHttp("chat.postMessage", { retryAfter: 0, status: 429 });

    const response = await callSlackApi({
      apiUrl: API_URL,
      body: { channel: "C1", text: "hello" },
      botToken: "xoxb-test",
      fetch: slack.fetch,
      operation: "chat.postMessage",
    });

    expect(response.ok).toBe(true);
    const attempts = slack.callsTo("chat.postMessage");
    expect(attempts).toHaveLength(2);
    // The replay carries the same payload, still form-encoded: a retry
    // that re-encoded the body would break the form-only methods.
    expect(attempts[1]?.contentType).toContain("application/x-www-form-urlencoded");
    expect(slack.bodyOf("chat.postMessage", 1)).toEqual({ channel: "C1", text: "hello" });
  });

  it("replays a JSON call without re-encoding it as a form", async () => {
    slack.allow("chat.update").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    slack.failNextHttp("chat.update", { retryAfter: 0, status: 429 });

    const response = await callSlackApiJson({
      api: { fetch: slack.fetch, url: API_URL },
      body: { channel: "C1", text: "after", ts: "1700.1" },
      method: "chat.update",
      token: "xoxb-test",
    });

    expect(response.ok).toBe(true);
    const attempts = slack.callsTo("chat.update");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.contentType).toContain("application/json");
    expect(slack.bodyOf("chat.update", 1)).toEqual({
      channel: "C1",
      text: "after",
      ts: "1700.1",
    });
  });

  it("throws the rate limit once the retries are spent", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      slack.failNextHttp("chat.postMessage", { retryAfter: 0, status: 429 });
    }

    await expect(
      callSlackApi({
        apiUrl: API_URL,
        body: { channel: "C1", text: "hello" },
        botToken: "xoxb-test",
        fetch: slack.fetch,
        operation: "chat.postMessage",
      }),
    ).rejects.toThrow(SlackApiError);

    expect(slack.callsTo("chat.postMessage")).toHaveLength(3);
  });

  it("does not replay a 5xx, which may have posted before the response was lost", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    slack.failNextHttp("chat.postMessage", { status: 503 });

    await expect(
      callSlackApi({
        apiUrl: API_URL,
        body: { channel: "C1", text: "hello" },
        botToken: "xoxb-test",
        fetch: slack.fetch,
        operation: "chat.postMessage",
      }),
    ).rejects.toThrow(SlackApiError);

    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });

  it("leaves a Slack-level failure alone: only HTTP 429 is a rate limit", async () => {
    slack.allow("chat.postMessage").andReturn({ ok: true, channel: "C1", ts: "1700.1" });
    slack.failNext("chat.postMessage", "channel_not_found");

    const response = await callSlackApi({
      apiUrl: API_URL,
      body: { channel: "C1", text: "hello" },
      botToken: "xoxb-test",
      fetch: slack.fetch,
      operation: "chat.postMessage",
    });

    expect(response).toMatchObject({ error: "channel_not_found", ok: false });
    expect(slack.callsTo("chat.postMessage")).toHaveLength(1);
  });
});

describe("Slack file transfer rate limiting", () => {
  let slack: MockSlack;

  beforeEach(() => {
    slack = mockSlack({ url: API_URL });
  });
  afterEach(() => {
    slack.assertNoViolations();
  });

  it("replays a rate-limited file download instead of failing the attachment", async () => {
    const api = { fetch: slack.fetch, url: API_URL };
    const url = slack.downloadUrl("F1/note.bin");
    slack.allowDownload(new Uint8Array([7, 8]));
    slack.failNextHttp("files.download", { retryAfter: 0, status: 429 });

    const result = await createSlackFetchFile({ api, botToken: "xoxb-test" })(url);

    expect(result?.bytes.equals(Buffer.from([7, 8]))).toBe(true);
    expect(slack.callsTo("files.download")).toHaveLength(2);
  });

  it("replays the rate-limited bytes POST of the upload handshake", async () => {
    allowUpload(slack);
    slack.failNextHttp("files.upload", { retryAfter: 0, status: 429 });
    const binding = buildSlackBinding({
      api: { fetch: slack.fetch, url: API_URL },
      botToken: "xoxb-test",
      channelId: "C01",
      teamId: undefined,
      threadTs: "1.0",
    });

    await binding.slack.uploadFiles([{ data: Buffer.from([1]), filename: "x.bin" }]);

    // The throttled POST sent no bytes; the replay is what delivered them.
    expect(slack.callsTo("files.upload")).toHaveLength(2);
    expect(slack.uploadedBytes()).toEqual([new Uint8Array([1])]);
    expect(slack.callsTo("files.completeUploadExternal")).toHaveLength(1);
  });
});
