import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { always, type ApprovalConfiguration } from "eve/tools/approval";

import { checkVideoJob, persistVideos, startVideoJob } from "../../extension/lib/engine.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import type { VideoStorage } from "../../extension/lib/storage/types.ts";
import {
  createGenerateApproval,
  createIdempotencyKey,
  formatGenerateCompleteLabel,
  formatGenerateProgressLabel,
} from "../../extension/lib/tools.ts";
import type {
  GenerateVideoToolInput,
  VideoExtensionConfig,
  VideoJobHandle,
  VideoJobStatus,
} from "../../extension/lib/types.ts";
import {
  MP4_BYTES,
  WEBM_BYTES,
  createAsyncVideoModel,
  createFakeApprovalContext,
  createFakeApprovalResponseContext,
  createFakePrincipal,
  createFakeSandbox,
  createHttpError,
  createLargePng,
  createSyncVideoModel,
  runGenerateVideos,
} from "../helpers.ts";

describe("generateVideos async lifecycle, idempotency keys, and labels", () => {
  test("streams starting -> generating -> saving -> completed, sets deterministic idempotency-key, and formats labels", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/videos" });
    const fake = createAsyncVideoModel({
      modelId: "google/veo-3.1-fast-generate-001",
      jobId: "job_async_42",
      startWarnings: [{ type: "other", message: "Using fast tier" }],
      statuses: [
        { status: "pending", warnings: [{ type: "other", message: "Using fast tier" }] },
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
          warnings: [{ type: "unsupported", feature: "fps", details: "fixed at 24" }],
        },
      ],
    });

    const config: VideoExtensionConfig = {
      model: fake.model,
      storage,
      poll: { intervalMs: 0 },
    };

    const sampleInput: GenerateVideoToolInput = {
      prompt: "Ocean waves at sunrise",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "720p",
    };

    const first = await runGenerateVideos({
      config,
      input: sampleInput,
      sessionId: "sess-a",
      idempotencyKey: createIdempotencyKey("sess-a", "call-1"),
    });

    assert.deepEqual(
      first.progress.map((p) => p.status),
      ["starting", "generating", "generating", "saving"],
    );
    assert.equal(first.progress[0].model, "google/veo-3.1-fast-generate-001");
    assert.equal(
      first.progress[1].status === "generating" ? first.progress[1].attempt : undefined,
      1,
    );
    assert.equal(
      first.progress[1].status === "generating" ? first.progress[1].jobId : undefined,
      "job_async_42",
    );
    assert.equal(
      first.progress[3].status === "saving" ? first.progress[3].videoCount : undefined,
      1,
    );

    assert.equal(first.output.status, "completed");
    assert.equal(first.output.model, "google/veo-3.1-fast-generate-001");
    assert.equal(first.output.jobId, "job_async_42");
    assert.equal(first.output.videos.length, 1);
    assert.equal(first.output.videos[0].mediaType, "video/mp4");
    assert.equal(first.output.videos[0].bytes, MP4_BYTES.byteLength);
    assert.ok(first.output.videos[0].url?.startsWith("https://media.example.test/videos/videos/"));
    assert.deepEqual(first.output.warnings, ["Using fast tier", "Unsupported fps: fixed at 24"]);

    const second = await runGenerateVideos({
      config,
      input: { prompt: "Ocean waves at sunrise" },
      sessionId: "sess-a",
      idempotencyKey: createIdempotencyKey("sess-a", "call-1"),
    });
    const third = await runGenerateVideos({
      config,
      input: { prompt: "Ocean waves at sunrise" },
      sessionId: "sess-a",
      idempotencyKey: createIdempotencyKey("sess-a", "call-2"),
    });

    assert.equal(second.output.status, "completed");
    assert.equal(third.output.status, "completed");
    assert.equal(fake.startCalls.length, 3);

    const key1 = (fake.startCalls[0].headers as Record<string, string>)["idempotency-key"];
    const key2 = (fake.startCalls[1].headers as Record<string, string>)["idempotency-key"];
    const key3 = (fake.startCalls[2].headers as Record<string, string>)["idempotency-key"];
    assert.equal(key1.length, 64);
    assert.equal(key1, key2);
    assert.notEqual(key1, key3);

    assert.equal(formatGenerateProgressLabel(first.progress[0]), "Starting video generation");
    assert.equal(formatGenerateProgressLabel(first.progress[1]), "Generating video");
    assert.equal(
      formatGenerateProgressLabel({
        status: "generating",
        model: "google/veo-3.1-fast-generate-001",
        elapsedSeconds: 12,
        attempt: 2,
      }),
      "Generating video (12s)",
    );
    assert.equal(formatGenerateProgressLabel(first.progress[3]), "Saving video");
    assert.equal(
      formatGenerateProgressLabel({
        status: "saving",
        model: "google/veo-3.1-fast-generate-001",
        videoCount: 2,
      }),
      "Saving 2 videos",
    );
    assert.equal(formatGenerateProgressLabel(first.output), "Generated video");
    assert.equal(formatGenerateCompleteLabel(first.output), "Generated video");
    assert.equal(
      formatGenerateCompleteLabel({
        ...first.output,
        videos: [...first.output.videos, ...first.output.videos],
      }),
      "Generated 2 videos",
    );
    assert.equal(formatGenerateCompleteLabel(first.progress[0]), "Generated video");
  });
});

describe("sync doGenerate fallback, batch persistence, and atomic cleanup", () => {
  test("downloads a provider URL via custom fetch using public IP SSRF path on doGenerate-only models", async () => {
    const storage = inMemory();
    const syncFake = createSyncVideoModel({
      modelId: "test/sync-v1",
      videos: [{ type: "url", url: "https://93.184.216.34/clip.mp4", mediaType: "video/mp4" }],
    });

    const downloadedUrls: string[] = [];
    const customFetch: typeof fetch = async (input) => {
      downloadedUrls.push(String(input));
      return new Response(MP4_BYTES, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    };

    const { progress, output: finalOutput } = await runGenerateVideos({
      config: { model: syncFake.model, storage },
      input: { prompt: "Sync clip" },
      fetch: customFetch,
    });

    assert.deepEqual(
      progress.map((p) => p.status),
      ["generating", "saving"],
    );
    assert.deepEqual(downloadedUrls, ["https://93.184.216.34/clip.mp4"]);
    assert.equal(syncFake.generateCalls.length, 1);
    assert.equal(finalOutput.videos.length, 1);
    const saved = await storage.get({
      key: finalOutput.videos[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(saved?.data, MP4_BYTES);
  });

  test("doGenerate-only model with storage: false and allowTemporaryProviderUrl passes through URL without downloading", async () => {
    const expiresAt = "2026-12-02T00:00:00.000Z";
    const syncFake = createSyncVideoModel({
      modelId: "test/sync-temp-url",
      videos: [
        {
          type: "url",
          url: "https://provider.example.com/temp/direct.mp4",
          mediaType: "video/mp4",
        },
      ],
      expiresAt,
    });

    let fetchCalls = 0;
    const { output: finalOutput } = await runGenerateVideos({
      config: {
        model: syncFake.model,
        storage: false,
        allowTemporaryProviderUrl: true,
      },
      input: { prompt: "Direct sync temporary URL" },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("should not download temporary provider URL");
      },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(syncFake.generateCalls.length, 1);
    assert.equal(finalOutput.videos.length, 1);
    assert.equal(finalOutput.videos[0].url, "https://provider.example.com/temp/direct.mp4");
    assert.equal(finalOutput.videos[0].expiresAt, expiresAt);
    assert.equal(finalOutput.videos[0].temporary, true);
    assert.equal(finalOutput.videos[0].bytes, 0);
  });

  test("persists multi-video batches to both storage and sandbox path with index suffixes", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test" });
    const sandbox = createFakeSandbox();
    const fake = createAsyncVideoModel({
      statuses: [
        {
          status: "completed",
          videos: [
            { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
            { type: "binary", data: WEBM_BYTES, mediaType: "video/webm" },
          ],
        },
      ],
    });

    const { output } = await runGenerateVideos({
      config: { model: fake.model, storage, poll: { intervalMs: 0 } },
      input: { prompt: "Two takes", n: 2, path: "videos/teaser.mp4" },
      getSandbox: async () => sandbox,
    });

    assert.equal(output.videos.length, 2);
    assert.equal(output.videos[0].path, "videos/teaser.mp4");
    assert.equal(output.videos[1].path, "videos/teaser-1.mp4");
    assert.ok(output.videos[0].storageKey?.endsWith(".mp4"));
    assert.ok(output.videos[1].storageKey?.endsWith("-1.webm"));

    assert.deepEqual(sandbox.files.get("videos/teaser.mp4"), MP4_BYTES);
    assert.deepEqual(sandbox.files.get("videos/teaser-1.mp4"), WEBM_BYTES);

    const signal = new AbortController().signal;
    const stored0 = await storage.get({ key: output.videos[0].storageKey as string, signal });
    const stored1 = await storage.get({ key: output.videos[1].storageKey as string, signal });
    assert.deepEqual(stored0?.data, MP4_BYTES);
    assert.deepEqual(stored1?.data, WEBM_BYTES);
  });

  test("deletes earlier stored objects if a later storage.put fails in a multi-video batch", async () => {
    const backing = inMemory();
    const deletedKeys: string[] = [];
    let putCount = 0;
    const flakyStorage: VideoStorage = {
      async put(input) {
        putCount += 1;
        if (putCount === 2) {
          throw new Error("storage quota exceeded");
        }
        return backing.put(input);
      },
      async get(input) {
        return backing.get(input);
      },
      async delete(input) {
        deletedKeys.push(input.key);
        return backing.delete(input);
      },
    };

    const fake = createAsyncVideoModel({
      statuses: [
        {
          status: "completed",
          videos: [
            { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
            { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
          ],
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage: flakyStorage, poll: { intervalMs: 0 } },
          input: { prompt: "Batch failure", n: 2 },
        }),
      /storage quota exceeded/,
    );
    assert.equal(deletedKeys.length, 1);
    assert.deepEqual(backing.keys(), []);
  });
});

describe("polling resilience, cancellation, and deterministic timeout", () => {
  test("recovers after two consecutive 503 poll errors", async () => {
    const storage = inMemory();
    const fake = createAsyncVideoModel({
      statuses: [
        async () => {
          throw createHttpError(503, "Service Unavailable 1");
        },
        async () => {
          throw createHttpError(503, "Service Unavailable 2");
        },
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    const { output } = await runGenerateVideos({
      config: { model: fake.model, storage, poll: { intervalMs: 0 } },
      input: { prompt: "Recover from 503" },
    });
    assert.equal(output.status, "completed");
    assert.equal(fake.statusCalls.length, 3);
  });

  test("fails immediately on non-transient 400 poll error without retrying", async () => {
    const storage = inMemory();
    const fake = createAsyncVideoModel({
      statuses: [
        async () => {
          throw createHttpError(400, "Bad status request");
        },
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage, poll: { intervalMs: 0 } },
          input: { prompt: "Immediate 400" },
        }),
      /Bad status request/,
    );
    assert.equal(fake.statusCalls.length, 1);
  });

  test("fails after more than 3 consecutive transient poll errors", async () => {
    const storage = inMemory();
    const fake = createAsyncVideoModel({
      statuses: [
        async () => {
          throw createHttpError(503, "Persistent 503");
        },
      ],
      repeatLastStatus: true,
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage, poll: { intervalMs: 0 } },
          input: { prompt: "Too many 503s" },
        }),
      /Persistent 503/,
    );
    assert.equal(fake.statusCalls.length, 4);
  });

  test("cancels cleanly via AbortSignal mid-poll without persisting outputs", async () => {
    const storage = inMemory();
    const controller = new AbortController();
    const fake = createAsyncVideoModel({
      statuses: [
        async () => {
          controller.abort(new Error("user cancelled poll"));
          return { status: "pending" };
        },
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage, poll: { intervalMs: 0 } },
          input: { prompt: "Cancel mid-poll" },
          signal: controller.signal,
        }),
      /user cancelled poll/,
    );
    assert.equal(fake.statusCalls.length, 1);
    assert.deepEqual(storage.keys(), []);
  });

  test("times out an always-pending job deterministically under fake timers and names modelId and jobId", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const storage = inMemory();
    const fake = createAsyncVideoModel({
      modelId: "test/slow-model",
      jobId: "job_timeout_99",
      statuses: [
        async () => {
          t.mock.timers.tick(600);
          return { status: "pending" };
        },
        async () => {
          t.mock.timers.tick(500);
          return { status: "pending" };
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage, poll: { intervalMs: 0, timeoutMs: 1_000 } },
          input: { prompt: "Never completes" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /test\/slow-model/);
        assert.match(error.message, /job_timeout_99/);
        assert.match(error.message, /timed out after 1000ms/);
        return true;
      },
    );
    assert.equal(fake.statusCalls.length, 2);
  });

  test("calls doStatus at least once before timing out when poll.intervalMs >= poll.timeoutMs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const storage = inMemory();
    const fake = createAsyncVideoModel({
      modelId: "test/equal-poll-timeout",
      jobId: "job_edge_1",
      statuses: [
        async () => {
          t.mock.timers.tick(1);
          return { status: "pending" };
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: { model: fake.model, storage, poll: { intervalMs: 5_000, timeoutMs: 1 } },
          input: { prompt: "Poll edge" },
        }),
      /test\/equal-poll-timeout.*job_edge_1.*timed out/,
    );
    assert.equal(fake.statusCalls.length, 1);
  });
});

describe("pre-flight gating before paid submission", () => {
  test("rejects invalid inputs, limits, destinations, media types, and unsafe URLs before doStart", async () => {
    const storage = inMemory();
    const sandboxWithVideo = createFakeSandbox({ "inputs/clip.mp4": MP4_BYTES });

    const cases: readonly {
      readonly name: string;
      readonly config: (
        model: ReturnType<typeof createAsyncVideoModel>["model"],
      ) => VideoExtensionConfig;
      readonly input: GenerateVideoToolInput;
      readonly sandbox?: ReturnType<typeof createFakeSandbox>;
      readonly pattern: RegExp;
    }[] = [
      {
        name: "no storage and no path",
        config: (model) => ({ model, storage: false, poll: { intervalMs: 0 } }),
        input: { prompt: "No destination" },
        pattern: /No video output destination is configured/,
      },
      {
        name: "missing sandbox for output path",
        config: (model) => ({ model, storage: false, poll: { intervalMs: 0 } }),
        input: { prompt: "Needs sandbox", path: "out/clip.mp4" },
        pattern: /requires an agent sandbox/,
      },
      {
        name: "duration exceeds maxDurationSeconds",
        config: (model) => ({
          model,
          storage,
          limits: { maxDurationSeconds: 8 },
          poll: { intervalMs: 0 },
        }),
        input: { prompt: "Too long", duration: 12 },
        pattern: /exceeds the configured maximum of 8s/,
      },
      {
        name: "n exceeds config maxVideosPerCall",
        config: (model) => ({
          model,
          storage,
          limits: { maxVideosPerCall: 2 },
          poll: { intervalMs: 0 },
        }),
        input: { prompt: "Too many", n: 3 },
        pattern: /exceeds the configured maximum of 2 videos per call/,
      },
      {
        name: "disallowed model",
        config: (model) => ({
          model,
          models: { allowed: model },
          storage,
          poll: { intervalMs: 0 },
        }),
        input: { prompt: "Wrong model", model: "unlisted" },
        pattern: /is not allowed/,
      },
      {
        name: "invalid aspectRatio",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "Bad ratio", aspectRatio: "wide" },
        pattern: /Invalid aspectRatio/,
      },
      {
        name: "invalid resolution",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "Bad resolution", resolution: "ultra-hd" },
        pattern: /Invalid resolution/,
      },
      {
        name: "non-image .mp4 URL passed to start",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "Bad start URL", start: "https://cdn.example.com/clip.mp4" },
        pattern: /Unsupported media type "video\/mp4" for "start"/,
      },
      {
        name: "non-image sandbox MP4 passed to start",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "Bad start file", start: "inputs/clip.mp4" },
        sandbox: sandboxWithVideo,
        pattern: /Unsupported media type "video\/mp4"/,
      },
      {
        name: "unsafe http:// URL passed to start",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "HTTP start", start: "http://cdn.example.com/frame.png" },
        pattern: /Refusing non-HTTPS URL/,
      },
      {
        name: "unsafe loopback https://127.0.0.1 URL passed to references",
        config: (model) => ({ model, storage, poll: { intervalMs: 0 } }),
        input: { prompt: "Loopback ref", references: ["https://127.0.0.1/frame.png"] },
        pattern: /Refusing private or reserved IP address/,
      },
    ];

    for (const tc of cases) {
      const fake = createAsyncVideoModel();
      const sandbox = tc.sandbox;
      await assert.rejects(
        () =>
          runGenerateVideos({
            config: tc.config(fake.model),
            input: tc.input,
            ...(sandbox !== undefined && { getSandbox: async () => sandbox }),
          }),
        tc.pattern,
        tc.name,
      );
      assert.equal(fake.startCalls.length, 0, `${tc.name}: expected zero doStart calls`);
    }
  });

  test("rejects n > model.maxVideosPerCall before staging inputs or calling doStart", async () => {
    const sandbox = createFakeSandbox({ "frames/large.png": createLargePng() });
    const storage = inMemory({ baseUrl: "https://cdn.example.test/media" });

    for (const maxVideosPerCall of [1, async () => 1] as const) {
      const fake = createAsyncVideoModel({
        modelId: "test/single-video-async",
        maxVideosPerCall,
      });

      await assert.rejects(
        () =>
          runGenerateVideos({
            config: { model: fake.model, storage, poll: { intervalMs: 0 } },
            input: { prompt: "Exceeds model cap", n: 2, start: "frames/large.png" },
            getSandbox: async () => sandbox,
          }),
        /supports at most 1 video\(s\) per async call, but 2 were requested/,
      );
      assert.equal(fake.startCalls.length, 0);
      assert.deepEqual(storage.keys(), []);
    }
  });

  test("rejects non-HTTP URL schemes in start and references without opening sandbox or calling doStart", async () => {
    const storage = inMemory();
    const cases: readonly GenerateVideoToolInput[] = [
      { prompt: "FTP start", start: "ftp://example.com/a.png" },
      { prompt: "File start", start: "file:///etc/passwd" },
      { prompt: "Data start", start: "data:image/png;base64,AA==" },
      { prompt: "FTP ref", references: ["ftp://example.com/a.png"] },
      { prompt: "File ref", references: ["file:///etc/passwd"] },
      { prompt: "Data ref", references: ["data:image/png;base64,AA=="] },
    ];

    for (const input of cases) {
      let sandboxCalls = 0;
      const fake = createAsyncVideoModel();

      await assert.rejects(
        () =>
          runGenerateVideos({
            config: { model: fake.model, storage, poll: { intervalMs: 0 } },
            input,
            getSandbox: async () => {
              sandboxCalls += 1;
              return createFakeSandbox();
            },
          }),
        /Refusing non-HTTPS URL/,
        input.prompt,
      );
      assert.equal(sandboxCalls, 0, `${input.prompt}: should not open sandbox`);
      assert.equal(fake.startCalls.length, 0, `${input.prompt}: should not call doStart`);
    }
  });
});

describe("large sandbox input staging and temporary provider URLs", () => {
  test("stages sandbox inputs larger than 180 KiB to public HTTPS storage, passes URL to doStart, and cleans up after completion", async () => {
    const sandbox = createFakeSandbox({ "frames/opening.png": createLargePng() });
    const storage = inMemory({ baseUrl: "https://cdn.example.test/media" });
    const stagedKeysSeenAtStart: string[] = [];

    const fake = createAsyncVideoModel({
      onStart() {
        stagedKeysSeenAtStart.push(...storage.keys());
      },
      statuses: [
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    const { output } = await runGenerateVideos({
      config: { model: fake.model, storage, poll: { intervalMs: 0 } },
      input: { prompt: "Animate opening frame", start: "frames/opening.png" },
      getSandbox: async () => sandbox,
    });

    assert.equal(output.status, "completed");
    assert.equal(stagedKeysSeenAtStart.length, 1);
    assert.ok(stagedKeysSeenAtStart[0].startsWith("inputs/"));
    assert.ok(stagedKeysSeenAtStart[0].endsWith("/start.png"));

    const frameImages = fake.startCalls[0].frameImages as readonly {
      readonly image: { readonly type: string; readonly url?: string };
      readonly frameType: string;
    }[];
    assert.equal(frameImages.length, 1);
    assert.equal(frameImages[0].frameType, "first_frame");
    assert.equal(frameImages[0].image.type, "url");
    assert.equal(
      frameImages[0].image.url,
      `https://cdn.example.test/media/${stagedKeysSeenAtStart[0]}`,
    );

    assert.deepEqual(storage.keys(), [output.videos[0].storageKey as string]);
  });

  test("allowTemporaryProviderUrl passes through provider URLs with expiresAt and rejects inline bytes without destination", async () => {
    const expiresAt = "2026-12-01T00:00:00.000Z";
    const urlModel = createAsyncVideoModel({
      statuses: [
        {
          status: "completed",
          videos: [
            {
              type: "url",
              url: "https://provider.example.com/temp/clip.mp4",
              mediaType: "video/mp4",
            },
          ],
          expiresAt,
        },
      ],
    });

    const { output } = await runGenerateVideos({
      config: {
        model: urlModel.model,
        storage: false,
        allowTemporaryProviderUrl: true,
        poll: { intervalMs: 0 },
      },
      input: { prompt: "Temporary URL clip" },
    });
    assert.equal(output.videos.length, 1);
    assert.equal(output.videos[0].url, "https://provider.example.com/temp/clip.mp4");
    assert.equal(output.videos[0].expiresAt, expiresAt);
    assert.equal(output.videos[0].temporary, true);
    assert.equal(output.videos[0].bytes, 0);

    const bytesModel = createAsyncVideoModel({
      statuses: [
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    await assert.rejects(
      () =>
        runGenerateVideos({
          config: {
            model: bytesModel.model,
            storage: false,
            allowTemporaryProviderUrl: true,
            poll: { intervalMs: 0 },
          },
          input: { prompt: "Inline bytes without storage" },
        }),
      /returned video bytes without a provider URL/,
    );
  });
});

describe("approval forwarding", () => {
  test("returns not-applicable with undefined response when unset, forwards always() without blocking response, and delegates custom policies", async () => {
    const input: GenerateVideoToolInput = {
      prompt: "Aerial drone shot of a coastal lighthouse at dusk",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1080p",
      audio: true,
      n: 2,
      path: "videos/lighthouse.mp4",
    };

    let currentConfig: VideoExtensionConfig = {
      model: "google/veo-3.1-fast-generate-001",
    };
    const approval = createGenerateApproval(() => currentConfig);
    const getApproval = (): ApprovalConfiguration<GenerateVideoToolInput> => approval;

    const approvalCtx = createFakeApprovalContext(input);
    assert.equal(await getApproval().request(approvalCtx), "not-applicable");
    assert.equal(getApproval().response, undefined);

    currentConfig = {
      model: "google/veo-3.1-fast-generate-001",
      approval: always(),
    };
    assert.equal(await getApproval().request(approvalCtx), "user-approval");
    assert.equal(getApproval().response, undefined);
    assert.equal(
      getApproval().prompt?.({ callId: "call-1", input, toolName: "video__generate" }),
      'Generate video with google/veo-3.1-fast-generate-001 (6s, 16:9, 1080p, audio, 2 videos, path: videos/lighthouse.mp4): "Aerial drone shot of a coastal lighthouse at dusk"',
    );

    const requester = createFakePrincipal("user-alice");
    const customApproval: ApprovalConfiguration<GenerateVideoToolInput> = {
      request() {
        return "user-approval";
      },
      prompt(ctx) {
        return `Custom prompt for ${ctx.input.prompt}`;
      },
      response(ctx) {
        return ctx.response.principal.principalId === "admin-1"
          ? { status: "allowed" }
          : { status: "rejected", reason: "Admins only." };
      },
    };
    currentConfig = {
      model: "google/veo-3.1-fast-generate-001",
      approval: customApproval,
    };

    assert.equal(
      getApproval().prompt?.({ callId: "call-1", input, toolName: "video__generate" }),
      "Custom prompt for Aerial drone shot of a coastal lighthouse at dusk",
    );
    const delegatedResponse = getApproval().response;
    assert.equal(typeof delegatedResponse, "function");
    assert.deepEqual(
      await delegatedResponse?.(
        createFakeApprovalResponseContext(input, {
          requester,
          responder: createFakePrincipal("admin-1"),
        }),
      ),
      { status: "allowed" },
    );
    assert.deepEqual(
      await delegatedResponse?.(
        createFakeApprovalResponseContext(input, { requester, responder: requester }),
      ),
      { status: "rejected", reason: "Admins only." },
    );
  });
});

describe("composable Workflow step primitives", () => {
  test("returns webhookSigningSecret and stagedInputKeys, round-trips alias catalog jobs through JSON, and supports omitted config in checkVideoJob", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/wf" });
    const sandbox = createFakeSandbox({ "frames/large.png": createLargePng() });
    const qualityFake = createAsyncVideoModel({
      modelId: "provider/quality-v1",
      jobId: "job_wf_7",
      webhookSigningSecret: "whsec_live_secret_7",
      operation: { providerJob: "op_serializable_7", version: 1 },
      statuses: [
        { status: "pending" },
        {
          status: "completed",
          videos: [
            { type: "url", url: "https://93.184.216.34/wf-clip.mp4", mediaType: "video/mp4" },
          ],
          expiresAt: "2026-12-01T12:00:00.000Z",
        },
      ],
    });
    const config: VideoExtensionConfig = {
      models: { quality: qualityFake.model },
    };

    const rawHandle = await startVideoJob({
      config,
      input: {
        prompt: "Durable workflow render",
        model: "quality",
        start: "frames/large.png",
        duration: 5,
      },
      storage,
      getSandbox: async () => sandbox,
      idempotencyKey: "wf-idem-1",
      webhookUrl: "https://hooks.example.com/eve/video",
    });
    const handle = JSON.parse(JSON.stringify(rawHandle)) as VideoJobHandle;

    assert.equal(handle.modelId, "provider/quality-v1");
    assert.equal(handle.jobId, "job_wf_7");
    assert.equal(handle.webhookSigningSecret, "whsec_live_secret_7");
    assert.equal(handle.stagedInputKeys?.length, 1);
    assert.ok(handle.stagedInputKeys?.[0].startsWith("inputs/"));
    assert.deepEqual(handle.operation, { providerJob: "op_serializable_7", version: 1 });
    assert.equal(qualityFake.startCalls[0].webhookUrl, "https://hooks.example.com/eve/video");
    assert.equal(
      (qualityFake.startCalls[0].headers as Record<string, string>)["idempotency-key"],
      "wf-idem-1",
    );

    const pendingStatus = JSON.parse(
      JSON.stringify(
        await checkVideoJob({
          config,
          modelId: handle.modelId,
          operation: handle.operation,
        }),
      ),
    ) as VideoJobStatus;
    assert.equal(pendingStatus.status, "pending");

    const completedStatus = JSON.parse(
      JSON.stringify(
        await checkVideoJob({
          config,
          modelId: handle.modelId,
          operation: handle.operation,
        }),
      ),
    ) as VideoJobStatus;
    assert.equal(completedStatus.status, "completed");
    if (completedStatus.status !== "completed") {
      assert.fail("Expected completed status");
    }
    assert.equal(completedStatus.expiresAt, "2026-12-01T12:00:00.000Z");

    const persisted = await persistVideos({
      videos: completedStatus.videos,
      modelId: handle.modelId,
      storage,
      jobId: handle.jobId,
      sessionId: "sess-wf-1",
      fetch: async () =>
        new Response(MP4_BYTES, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    });

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].mediaType, "video/mp4");
    assert.equal(persisted[0].bytes, MP4_BYTES.byteLength);
    const loaded = await storage.get({
      key: persisted[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(loaded?.data, MP4_BYTES);

    const previousProvider = Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    const nonDefaultFake = createAsyncVideoModel({
      modelId: "klingai/kling-v2.6-pro",
      statuses: [{ status: "pending" }],
    });
    try {
      Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", {
        videoModel(id: string) {
          assert.equal(id, "klingai/kling-v2.6-pro");
          return nonDefaultFake.model;
        },
      });
      const statusWithoutConfig = await checkVideoJob({
        modelId: "klingai/kling-v2.6-pro",
        operation: { id: "op_no_config" },
      });
      assert.equal(statusWithoutConfig.status, "pending");
      assert.equal(nonDefaultFake.statusCalls.length, 1);
    } finally {
      if (previousProvider === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_DEFAULT_PROVIDER");
      } else {
        Reflect.set(globalThis, "AI_SDK_DEFAULT_PROVIDER", previousProvider);
      }
    }
  });

  test("startVideoJob cleans up staged inputs on start failure and auto-selects storage from env when omitted", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/fail-clean" });
    const sandbox = createFakeSandbox({ "frames/large.png": createLargePng() });
    const failingFake = createAsyncVideoModel({
      onStart() {
        throw new Error("provider rejected start");
      },
    });

    await assert.rejects(
      () =>
        startVideoJob({
          config: { model: failingFake.model },
          input: { prompt: "Fail after staging", start: "frames/large.png" },
          storage,
          getSandbox: async () => sandbox,
        }),
      /provider rejected start/,
    );
    assert.deepEqual(storage.keys(), []);

    const uploadedPathnames: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = parsed.searchParams.get("pathname") ?? "";
      uploadedPathnames.push(pathname);
      req.resume();
      req.on("end", () => {
        const url = `https://storeauto.public.blob.vercel-storage.com/${pathname}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            url,
            downloadUrl: `${url}?download=1`,
            pathname,
            contentType: "image/png",
            contentDisposition: 'inline; filename="start.png"',
            etag: '"etag-auto"',
          }),
        );
      });
    });

    const envKeys = [
      "VERCEL_BLOB_API_URL",
      "EVE_VIDEO_BLOB_READ_WRITE_TOKEN",
      "EVE_VIDEO_BLOB_STORE_ID",
      "BLOB_READ_WRITE_TOKEN",
      "BLOB_STORE_ID",
      "VERCEL_OIDC_TOKEN",
      "VERCEL",
    ] as const;
    const saved = new Map<string, string | undefined>(envKeys.map((k) => [k, process.env[k]]));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const k of envKeys) delete process.env[k];
      process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}`;
      process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_storeauto_secret";

      const autoFake = createAsyncVideoModel({ modelId: "test/auto-stage" });
      const handle = await startVideoJob({
        config: { model: autoFake.model },
        input: { prompt: "Stage via env storage", start: "frames/large.png" },
        getSandbox: async () => sandbox,
      });

      assert.equal(uploadedPathnames.length, 1);
      assert.ok(uploadedPathnames[0].startsWith("eve/video/inputs/"));
      assert.equal(handle.stagedInputKeys?.length, 1);
      assert.ok(handle.stagedInputKeys?.[0].startsWith("inputs/"));
    } finally {
      for (const k of envKeys) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err !== undefined ? reject(err) : resolve())),
      );
    }
  });
});
