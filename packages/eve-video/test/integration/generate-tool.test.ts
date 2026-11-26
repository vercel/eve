import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { always, type ApprovalConfiguration } from "eve/tools/approval";

import {
  checkVideoJob,
  persistVideos,
  runSyncVideoModel,
  startVideoJob,
} from "../../extension/lib/engine.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import type { VideoStorage } from "../../extension/lib/storage/types.ts";
import {
  createGenerateApproval,
  createIdempotencyKey,
  formatGenerateCompleteLabel,
  formatGenerateProgressLabel,
  generateVideoInputSchema,
} from "../../extension/lib/tools.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  VideoExtensionConfig,
  VideoJobHandle,
  VideoJobStatus,
} from "../../extension/lib/types.ts";
import {
  MP4_BYTES,
  PNG_BYTES,
  WEBM_BYTES,
  createAsyncVideoModel,
  createFakeApprovalContext,
  createFakeApprovalResponseContext,
  createFakePrincipal,
  createFakeSandbox,
  createLargePng,
  createSyncVideoModel,
} from "../helpers.ts";

function createLargeMp4(): Uint8Array {
  const bytes = new Uint8Array(185 * 1024);
  bytes.set(MP4_BYTES, 0);
  return bytes;
}

describe("tool labels, idempotency keys, and input schema", () => {
  test("derives deterministic idempotency keys and formats progress and completion labels", () => {
    const key1 = createIdempotencyKey("sess-a", "call-1");
    const key2 = createIdempotencyKey("sess-a", "call-1");
    const key3 = createIdempotencyKey("sess-a", "call-2");
    const key4 = createIdempotencyKey("sess-b", "call-1");
    assert.equal(key1.length, 64);
    assert.equal(key1, key2);
    assert.notEqual(key1, key3);
    assert.notEqual(key1, key4);

    const generatingZero = {
      status: "generating" as const,
      model: "google/veo-3.1-fast-generate-001",
      jobId: "job_1",
      elapsedSeconds: 0,
      attempt: 1,
    };
    const generatingElapsed = {
      status: "generating" as const,
      model: "google/veo-3.1-fast-generate-001",
      elapsedSeconds: 12,
      attempt: 2,
    };
    const completedOne: GenerateVideoToolOutput = {
      status: "completed",
      model: "google/veo-3.1-fast-generate-001",
      videos: [{ mediaType: "video/mp4", bytes: MP4_BYTES.byteLength }],
    };
    const completedTwo: GenerateVideoToolOutput = {
      ...completedOne,
      videos: [...completedOne.videos, ...completedOne.videos],
    };

    assert.equal(formatGenerateProgressLabel(generatingZero), "Generating video");
    assert.equal(formatGenerateProgressLabel(generatingElapsed), "Generating video (12s)");
    assert.equal(formatGenerateProgressLabel(completedOne), "Generated video");
    assert.equal(formatGenerateProgressLabel(completedTwo), "Generated 2 videos");
    assert.equal(formatGenerateCompleteLabel(completedOne), "Generated video");
    assert.equal(formatGenerateCompleteLabel(completedTwo), "Generated 2 videos");
    assert.equal(formatGenerateCompleteLabel(generatingZero), "Generated video");
  });

  test("validates video and mode fields in generateVideoInputSchema", () => {
    const edited = generateVideoInputSchema.parse({
      prompt: "Add warm sunset lighting",
      video: "  videos/2026-11-26/clip.mp4  ",
      mode: "edit",
    });
    assert.equal(edited.video, "videos/2026-11-26/clip.mp4");
    assert.equal(edited.mode, "edit");

    const extended = generateVideoInputSchema.parse({
      prompt: "Continue camera pan to the harbor",
      video: "https://cdn.example.com/clip.mp4",
      mode: "extend",
    });
    assert.equal(extended.video, "https://cdn.example.com/clip.mp4");
    assert.equal(extended.mode, "extend");

    const defaultMode = generateVideoInputSchema.parse({
      prompt: "Color grade as film noir",
      video: "videos/2026-11-26/clip.mp4",
    });
    assert.equal(defaultMode.video, "videos/2026-11-26/clip.mp4");
    assert.equal(defaultMode.mode, undefined);

    assert.equal(
      generateVideoInputSchema.safeParse({ prompt: "Bad video", video: "   " }).success,
      false,
    );
    assert.equal(
      generateVideoInputSchema.safeParse({
        prompt: "Bad mode",
        video: "videos/2026-11-26/clip.mp4",
        mode: "upscale",
      }).success,
      false,
    );
  });
});

describe("runSyncVideoModel and persistVideos", () => {
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

    const output = await runSyncVideoModel({
      config: { model: syncFake.model, storage },
      input: { prompt: "Sync clip" },
      idempotencyKey: createIdempotencyKey("sess-sync", "call-1"),
      fetch: customFetch,
    });

    assert.equal(output.status, "completed");
    assert.deepEqual(downloadedUrls, ["https://93.184.216.34/clip.mp4"]);
    assert.equal(syncFake.generateCalls.length, 1);
    assert.equal(
      (syncFake.generateCalls[0].headers as Record<string, string>)["idempotency-key"],
      createIdempotencyKey("sess-sync", "call-1"),
    );
    assert.equal(output.videos.length, 1);
    const saved = await storage.get({
      key: output.videos[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(saved?.data, MP4_BYTES);
  });

  test("passes through temporary provider URLs on doGenerate-only models without downloading", async () => {
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
    const output = await runSyncVideoModel({
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
    assert.equal(output.videos.length, 1);
    assert.equal(output.videos[0].url, "https://provider.example.com/temp/direct.mp4");
    assert.equal(output.videos[0].expiresAt, expiresAt);
    assert.equal(output.videos[0].temporary, true);
    assert.equal(output.videos[0].bytes, 0);
  });

  test("persists multi-video batches to both storage and sandbox path with index suffixes", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test" });
    const sandbox = createFakeSandbox();

    const persisted = await persistVideos({
      videos: [
        { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
        { type: "binary", data: WEBM_BYTES, mediaType: "video/webm" },
      ],
      modelId: "test/video-batch",
      storage,
      sandbox,
      path: "videos/clip.mp4",
    });

    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].path, "videos/clip.mp4");
    assert.equal(persisted[1].path, "videos/clip-1.mp4");
    assert.ok(persisted[0].storageKey?.endsWith(".mp4"));
    assert.ok(persisted[1].storageKey?.endsWith("-1.webm"));

    assert.deepEqual(sandbox.files.get("videos/clip.mp4"), MP4_BYTES);
    assert.deepEqual(sandbox.files.get("videos/clip-1.mp4"), WEBM_BYTES);

    const signal = new AbortController().signal;
    const stored0 = await storage.get({ key: persisted[0].storageKey as string, signal });
    const stored1 = await storage.get({ key: persisted[1].storageKey as string, signal });
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

    await assert.rejects(
      () =>
        persistVideos({
          videos: [
            { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
            { type: "binary", data: MP4_BYTES, mediaType: "video/mp4" },
          ],
          modelId: "test/batch-fail",
          storage: flakyStorage,
        }),
      /storage quota exceeded/,
    );
    assert.equal(deletedKeys.length, 1);
    assert.deepEqual(backing.keys(), []);
  });

  test("passes through provider URLs with allowTemporaryProviderUrl and rejects inline bytes without a destination", async () => {
    const expiresAt = "2026-12-01T00:00:00.000Z";
    const temporary = await persistVideos({
      videos: [
        {
          type: "url",
          url: "https://provider.example.com/temp/clip.mp4",
          mediaType: "video/mp4",
        },
      ],
      modelId: "test/temp-url",
      allowTemporaryProviderUrl: true,
      providerExpiresAt: expiresAt,
    });
    assert.equal(temporary.length, 1);
    assert.equal(temporary[0].url, "https://provider.example.com/temp/clip.mp4");
    assert.equal(temporary[0].expiresAt, expiresAt);
    assert.equal(temporary[0].temporary, true);
    assert.equal(temporary[0].bytes, 0);

    await assert.rejects(
      () =>
        persistVideos({
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
          modelId: "test/inline-bytes",
          allowTemporaryProviderUrl: true,
        }),
      /returned video bytes without a provider URL/,
    );

    await assert.rejects(
      () =>
        persistVideos({
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
          modelId: "test/no-dest",
        }),
      /No video output destination is configured/,
    );
  });
});

describe("pre-flight gating before paid submission", () => {
  test("rejects invalid inputs, video/mode conflicts, limits, media types, and unsafe URLs before doStart", async () => {
    const storage = inMemory();
    const sandboxWithMedia = createFakeSandbox({
      "inputs/clip.mp4": MP4_BYTES,
      "inputs/frame.png": PNG_BYTES,
    });

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
        name: "mode edit without video",
        config: (model) => ({ model, storage }),
        input: { prompt: "Edit nothing", mode: "edit" },
        pattern: /"mode" \("edit" or "extend"\) requires "video" to be provided/,
      },
      {
        name: "mode extend without video",
        config: (model) => ({ model, storage }),
        input: { prompt: "Extend nothing", mode: "extend" },
        pattern: /"mode" \("edit" or "extend"\) requires "video" to be provided/,
      },
      {
        name: "video combined with start",
        config: (model) => ({ model, storage }),
        input: {
          prompt: "Conflict with start",
          video: "https://cdn.example.com/clip.mp4",
          start: "https://cdn.example.com/frame.png",
        },
        pattern: /"video" cannot be combined with "start" or "end"/,
      },
      {
        name: "video combined with end",
        config: (model) => ({ model, storage }),
        input: {
          prompt: "Conflict with end",
          video: "https://cdn.example.com/clip.mp4",
          end: "https://cdn.example.com/frame.png",
        },
        pattern: /"video" cannot be combined with "start" or "end"/,
      },
      {
        name: "empty video string",
        config: (model) => ({ model, storage }),
        input: { prompt: "Empty video", video: "   " },
        pattern: /Input "video" must be a non-empty/,
      },
      {
        name: "non-video image URL passed as video",
        config: (model) => ({ model, storage }),
        input: { prompt: "Image URL as video", video: "https://cdn.example.com/frame.png" },
        pattern: /Unsupported media type "image\/png" for "video"/,
      },
      {
        name: "non-video sandbox PNG passed as video",
        config: (model) => ({ model, storage }),
        input: { prompt: "Image file as video", video: "inputs/frame.png" },
        sandbox: sandboxWithMedia,
        pattern: /Unsupported media type "image\/png"/,
      },
      {
        name: "duration exceeds maxDurationSeconds",
        config: (model) => ({
          model,
          storage,
          limits: { maxDurationSeconds: 8 },
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
        }),
        input: { prompt: "Wrong model", model: "unlisted" },
        pattern: /is not allowed/,
      },
      {
        name: "invalid aspectRatio",
        config: (model) => ({ model, storage }),
        input: { prompt: "Bad ratio", aspectRatio: "wide" },
        pattern: /Invalid aspectRatio/,
      },
      {
        name: "invalid resolution",
        config: (model) => ({ model, storage }),
        input: { prompt: "Bad resolution", resolution: "ultra-hd" },
        pattern: /Invalid resolution/,
      },
      {
        name: "non-image .mp4 URL passed to start",
        config: (model) => ({ model, storage }),
        input: { prompt: "Bad start URL", start: "https://cdn.example.com/clip.mp4" },
        pattern: /Unsupported media type "video\/mp4" for "start"/,
      },
      {
        name: "non-image sandbox MP4 passed to start",
        config: (model) => ({ model, storage }),
        input: { prompt: "Bad start file", start: "inputs/clip.mp4" },
        sandbox: sandboxWithMedia,
        pattern: /Unsupported media type "video\/mp4"/,
      },
      {
        name: "unsafe http:// URL passed to start",
        config: (model) => ({ model, storage }),
        input: { prompt: "HTTP start", start: "http://cdn.example.com/frame.png" },
        pattern: /Refusing non-HTTPS URL/,
      },
      {
        name: "unsafe loopback https://127.0.0.1 URL passed to references",
        config: (model) => ({ model, storage }),
        input: { prompt: "Loopback ref", references: ["https://127.0.0.1/frame.png"] },
        pattern: /Refusing private or reserved IP address/,
      },
      {
        name: "unsafe loopback https://127.0.0.1 URL passed to video",
        config: (model) => ({ model, storage }),
        input: { prompt: "Loopback video", video: "https://127.0.0.1/clip.mp4" },
        pattern: /Refusing private or reserved IP address/,
      },
    ];

    for (const tc of cases) {
      const fake = createAsyncVideoModel();
      const sandbox = tc.sandbox;
      await assert.rejects(
        () =>
          startVideoJob({
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

  test("rejects missing output destination or missing sandbox path before doGenerate in runSyncVideoModel", async () => {
    const noDestFake = createSyncVideoModel();
    await assert.rejects(
      () =>
        runSyncVideoModel({
          config: { model: noDestFake.model, storage: false },
          input: { prompt: "No destination" },
        }),
      /No video output destination is configured/,
    );
    assert.equal(noDestFake.generateCalls.length, 0);

    const noSandboxFake = createSyncVideoModel();
    await assert.rejects(
      () =>
        runSyncVideoModel({
          config: { model: noSandboxFake.model, storage: false },
          input: { prompt: "Needs sandbox", path: "out/clip.mp4" },
        }),
      /requires an agent sandbox/,
    );
    assert.equal(noSandboxFake.generateCalls.length, 0);
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
          startVideoJob({
            config: { model: fake.model, storage },
            input: { prompt: "Exceeds model cap", n: 2, start: "frames/large.png" },
            getSandbox: async () => sandbox,
          }),
        /supports at most 1 video\(s\) per async call, but 2 were requested/,
      );
      assert.equal(fake.startCalls.length, 0);
      assert.deepEqual(storage.keys(), []);
    }
  });

  test("rejects non-HTTP URL schemes in video, start, and references without opening sandbox or calling doStart", async () => {
    const storage = inMemory();
    const cases: readonly GenerateVideoToolInput[] = [
      { prompt: "FTP video", video: "ftp://example.com/a.mp4" },
      { prompt: "File video", video: "file:///etc/passwd" },
      { prompt: "Data video", video: "data:video/mp4;base64,AA==" },
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
          startVideoJob({
            config: { model: fake.model, storage },
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

describe("video editing and extension routing", () => {
  test("routes Grok Imagine Video edit mode via providerOptions.xai.videoUrl, omits duration/aspectRatio/resolution, and preserves existing xai options", async () => {
    const fake = createAsyncVideoModel({
      modelId: "spacexai/grok-imagine-video",
      provider: "gateway",
    });
    const config: VideoExtensionConfig = {
      model: fake.model,
      defaults: {
        duration: 6,
        aspectRatio: "16:9",
        resolution: "1080p",
      },
      providerOptions: {
        xai: { style: "cinematic" },
        other: { trace: "yes" },
      },
    };

    await startVideoJob({
      config,
      input: {
        prompt: "Replace rain with snow",
        video: "https://cdn.example.com/source.mp4",
      },
    });
    await startVideoJob({
      config,
      input: {
        prompt: "Replace rain with snow explicitly",
        video: "https://cdn.example.com/source.mp4",
        mode: "edit",
        duration: 8,
        aspectRatio: "9:16",
        resolution: "720p",
      },
    });

    assert.equal(fake.startCalls.length, 2);
    for (const call of fake.startCalls) {
      assert.equal(call.inputReferences, undefined);
      assert.equal(call.frameImages, undefined);
      assert.equal(call.duration, undefined);
      assert.equal(call.aspectRatio, undefined);
      assert.equal(call.resolution, undefined);
      assert.deepEqual(call.providerOptions, {
        xai: {
          style: "cinematic",
          videoUrl: "https://cdn.example.com/source.mp4",
        },
        other: { trace: "yes" },
      });
    }
  });

  test("routes Grok Imagine Video extend mode via providerOptions.xai with extend-video and forwards duration", async () => {
    const fake = createAsyncVideoModel({
      modelId: "spacexai/grok-imagine-video",
      provider: "gateway",
    });
    const config: VideoExtensionConfig = {
      model: fake.model,
      defaults: {
        duration: 6,
        aspectRatio: "16:9",
        resolution: "720p",
      },
      providerOptions: {
        xai: { style: "documentary" },
      },
    };

    await startVideoJob({
      config,
      input: {
        prompt: "Continue following the train into the tunnel",
        video: "https://cdn.example.com/train.mp4",
        mode: "extend",
        duration: 5,
      },
    });

    assert.equal(fake.startCalls.length, 1);
    const call = fake.startCalls[0];
    assert.equal(call.inputReferences, undefined);
    assert.equal(call.duration, 5);
    assert.equal(call.aspectRatio, "16:9");
    assert.equal(call.resolution, "1280x720");
    assert.deepEqual(call.providerOptions, {
      xai: {
        style: "documentary",
        videoUrl: "https://cdn.example.com/train.mp4",
        mode: "extend-video",
      },
    });
  });

  test("stages sandbox and storageKey MP4 inputs to public HTTPS storage for Grok and rejects private or non-HTTPS storage before doStart", async () => {
    const storage = inMemory({ baseUrl: "https://cdn.example.test/grok" });
    const sandbox = createFakeSandbox({ "clips/local.mp4": MP4_BYTES });
    const fake = createAsyncVideoModel({
      modelId: "spacexai/grok-imagine-video",
      provider: "gateway",
    });

    const sandboxHandle = await startVideoJob({
      config: { model: fake.model, storage },
      input: { prompt: "Add dramatic fog", video: "clips/local.mp4" },
      getSandbox: async () => sandbox,
    });
    assert.equal(sandboxHandle.stagedInputKeys?.length, 1);
    const stagedFromSandbox = sandboxHandle.stagedInputKeys?.[0] as string;
    assert.ok(stagedFromSandbox.startsWith("inputs/"));
    assert.ok(stagedFromSandbox.endsWith("/video.mp4"));
    assert.equal(fake.startCalls[0].inputReferences, undefined);
    assert.deepEqual(fake.startCalls[0].providerOptions, {
      xai: { videoUrl: `https://cdn.example.test/grok/${stagedFromSandbox}` },
    });

    await storage.put({
      key: "videos/2026-11-26/prior.mp4",
      data: MP4_BYTES,
      mediaType: "video/mp4",
      filename: "prior.mp4",
      signal: new AbortController().signal,
    });

    const storageKeyHandle = await startVideoJob({
      config: { model: fake.model, storage },
      input: {
        prompt: "Continue with fireworks",
        video: "videos/2026-11-26/prior.mp4",
        mode: "extend",
        duration: 4,
      },
    });
    assert.equal(storageKeyHandle.stagedInputKeys?.length, 1);
    const stagedFromStorage = storageKeyHandle.stagedInputKeys?.[0] as string;
    assert.ok(stagedFromStorage.startsWith("inputs/"));
    assert.ok(stagedFromStorage.endsWith("/video.mp4"));
    assert.deepEqual(fake.startCalls[1].providerOptions, {
      xai: {
        videoUrl: `https://cdn.example.test/grok/${stagedFromStorage}`,
        mode: "extend-video",
      },
    });

    const unusableStorages: readonly {
      readonly name: string;
      readonly storage?: ReturnType<typeof inMemory>;
    }[] = [
      {
        name: "private HTTPS storage",
        storage: inMemory({
          baseUrl: "https://cdn.example.test/private",
          visibility: "private",
        }),
      },
      {
        name: "non-HTTPS http:// storage",
        storage: inMemory({ baseUrl: "http://cdn.example.test/insecure" }),
      },
      {
        name: "storage without URL",
        storage: inMemory(),
      },
      {
        name: "storage disabled",
      },
    ];

    for (const tc of unusableStorages) {
      const blockedFake = createAsyncVideoModel({
        modelId: "spacexai/grok-imagine-video",
        provider: "gateway",
      });
      await assert.rejects(
        () =>
          startVideoJob({
            config: { model: blockedFake.model, storage: tc.storage ?? false },
            input: { prompt: "Edit local clip", video: "clips/local.mp4" },
            getSandbox: async () => sandbox,
          }),
        /requires a public https:\/\/ video URL/,
        tc.name,
      );
      assert.equal(blockedFake.startCalls.length, 0, `${tc.name}: expected zero doStart calls`);
      if (tc.storage !== undefined) {
        assert.deepEqual(tc.storage.keys(), [], `${tc.name}: expected staged key cleanup`);
      }
    }
  });

  test("routes Seedance edit and extend modes via inputReferences[0] with video/mp4 mediaType and omits aspectRatio on extend", async () => {
    const fake = createAsyncVideoModel({
      modelId: "bytedance/seedance-2.5",
      provider: "gateway",
    });
    const config: VideoExtensionConfig = {
      model: fake.model,
      defaults: {
        aspectRatio: "16:9",
        resolution: "720p",
        duration: 5,
      },
    };

    await startVideoJob({
      config,
      input: {
        prompt: "Match the character outfit from the reference image",
        video: "https://cdn.example.com/clip.mp4",
        mode: "edit",
        references: ["https://cdn.example.com/character.png"],
      },
    });

    assert.equal(fake.startCalls.length, 1);
    assert.deepEqual(fake.startCalls[0].inputReferences, [
      { type: "url", url: "https://cdn.example.com/clip.mp4", mediaType: "video/mp4" },
      { type: "url", url: "https://cdn.example.com/character.png", mediaType: "image/png" },
    ]);
    assert.equal(fake.startCalls[0].aspectRatio, "16:9");
    assert.equal(fake.startCalls[0].resolution, "1280x720");
    assert.equal(fake.startCalls[0].duration, 5);
    assert.deepEqual(fake.startCalls[0].providerOptions, {});

    await startVideoJob({
      config,
      input: {
        prompt: "Continue the walk across the bridge",
        video: "https://cdn.example.com/clip.mp4",
        mode: "extend",
        references: ["https://cdn.example.com/lighting.png"],
      },
    });

    assert.equal(fake.startCalls.length, 2);
    assert.deepEqual(fake.startCalls[1].inputReferences, [
      { type: "url", url: "https://cdn.example.com/clip.mp4", mediaType: "video/mp4" },
      { type: "url", url: "https://cdn.example.com/lighting.png", mediaType: "image/png" },
    ]);
    assert.equal(fake.startCalls[1].aspectRatio, undefined);
    assert.equal(fake.startCalls[1].resolution, "1280x720");
    assert.equal(fake.startCalls[1].duration, 5);
  });

  test("routes FLUX 3 and generic models via inputReferences[0] with video/mp4 default and stages oversized local MP4s", async () => {
    const storage = inMemory({ baseUrl: "https://cdn.example.test/flux" });
    const sandbox = createFakeSandbox({ "clips/oversized.mp4": createLargeMp4() });
    const fake = createAsyncVideoModel({
      modelId: "bfl/flux-3-video",
      provider: "gateway",
    });

    await startVideoJob({
      config: { model: fake.model, storage, defaults: { aspectRatio: "16:9", duration: 4 } },
      input: {
        prompt: "Extend with crane pull-back",
        video: "https://cdn.example.com/assets/clip-no-ext",
        mode: "extend",
        references: ["https://cdn.example.com/palette.png"],
      },
    });

    assert.equal(fake.startCalls.length, 1);
    assert.deepEqual(fake.startCalls[0].inputReferences, [
      { type: "url", url: "https://cdn.example.com/assets/clip-no-ext", mediaType: "video/mp4" },
      { type: "url", url: "https://cdn.example.com/palette.png", mediaType: "image/png" },
    ]);
    assert.equal(fake.startCalls[0].aspectRatio, "16:9");
    assert.equal(fake.startCalls[0].duration, 4);

    const stagedHandle = await startVideoJob({
      config: { model: fake.model, storage },
      input: {
        prompt: "Re-light oversized clip",
        video: "clips/oversized.mp4",
      },
      getSandbox: async () => sandbox,
    });

    assert.equal(stagedHandle.stagedInputKeys?.length, 1);
    const stagedKey = stagedHandle.stagedInputKeys?.[0] as string;
    assert.ok(stagedKey.startsWith("inputs/"));
    assert.ok(stagedKey.endsWith("/video.mp4"));
    assert.deepEqual(fake.startCalls[1].inputReferences, [
      {
        type: "url",
        url: `https://cdn.example.test/flux/${stagedKey}`,
        mediaType: "video/mp4",
      },
    ]);
  });

  test("resolves stored video by storageKey without a sandbox and falls back to storage.get when sandbox returns null", async () => {
    const storage = inMemory({ baseUrl: "https://storage.example" });
    const signal = new AbortController().signal;
    await storage.put({
      key: "videos/2026-11-26/clip.mp4",
      data: MP4_BYTES,
      mediaType: "video/mp4",
      filename: "clip.mp4",
      signal,
    });
    await storage.put({
      key: "videos/2026-11-26/large.mp4",
      data: createLargeMp4(),
      mediaType: "video/mp4",
      filename: "large.mp4",
      signal,
    });

    const fake = createAsyncVideoModel({
      modelId: "bfl/flux-3-video",
      provider: "gateway",
    });

    const inlineHandle = await startVideoJob({
      config: { model: fake.model, storage },
      input: {
        prompt: "Edit stored clip with no sandbox",
        video: "videos/2026-11-26/clip.mp4",
      },
    });
    assert.equal(inlineHandle.stagedInputKeys, undefined);
    assert.deepEqual(fake.startCalls[0].inputReferences, [
      { type: "file", data: MP4_BYTES, mediaType: "video/mp4" },
    ]);

    const stagedHandle = await startVideoJob({
      config: { model: fake.model, storage },
      input: {
        prompt: "Edit large stored clip with no sandbox",
        video: "videos/2026-11-26/large.mp4",
      },
    });
    assert.equal(stagedHandle.stagedInputKeys?.length, 1);
    const stagedKey = stagedHandle.stagedInputKeys?.[0] as string;
    assert.ok(stagedKey.startsWith("inputs/"));
    assert.ok(stagedKey.endsWith("/video.mp4"));
    assert.deepEqual(fake.startCalls[1].inputReferences, [
      {
        type: "url",
        url: `https://storage.example/${stagedKey}`,
        mediaType: "video/mp4",
      },
    ]);

    const emptySandbox = createFakeSandbox();
    await startVideoJob({
      config: { model: fake.model, storage },
      input: {
        prompt: "Fallback to storage.get when sandbox misses",
        video: "videos/2026-11-26/clip.mp4",
      },
      getSandbox: async () => emptySandbox,
    });
    assert.deepEqual(fake.startCalls[2].inputReferences, [
      { type: "file", data: MP4_BYTES, mediaType: "video/mp4" },
    ]);

    const missingFake = createAsyncVideoModel({ modelId: "bfl/flux-3-video" });
    await assert.rejects(
      () =>
        startVideoJob({
          config: { model: missingFake.model, storage },
          input: {
            prompt: "Missing stored key",
            video: "videos/2026-11-26/missing.mp4",
          },
        }),
      /was not found in video storage/,
    );
    assert.equal(missingFake.startCalls.length, 0);
  });
});

describe("approval forwarding", () => {
  test("returns not-applicable when unset, formats Generate/Edit/Extend prompts, and delegates custom policies", async () => {
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
    assert.equal(
      getApproval().prompt?.({
        callId: "call-2",
        input: {
          prompt: "Shift sky to twilight",
          video: "  videos/2026-11-26/clip.mp4  ",
        },
        toolName: "video__generate",
      }),
      'Edit video with google/veo-3.1-fast-generate-001 (video: videos/2026-11-26/clip.mp4): "Shift sky to twilight"',
    );
    assert.equal(
      getApproval().prompt?.({
        callId: "call-3",
        input: {
          prompt: "Add gentle snowfall",
          video: "videos/2026-11-26/clip.mp4",
          mode: "edit",
        },
        toolName: "video__generate",
      }),
      'Edit video with google/veo-3.1-fast-generate-001 (video: videos/2026-11-26/clip.mp4): "Add gentle snowfall"',
    );
    assert.equal(
      getApproval().prompt?.({
        callId: "call-4",
        input: {
          prompt: "Continue the drone pan across the harbor",
          video: "https://cdn.example.com/clip.mp4",
          mode: "extend",
          duration: 5,
        },
        toolName: "video__generate",
      }),
      'Extend video with google/veo-3.1-fast-generate-001 (video: https://cdn.example.com/clip.mp4, 5s): "Continue the drone pan across the harbor"',
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

describe("composable Workflow step primitives and input staging", () => {
  test("stages large sandbox inputs, returns webhookSigningSecret and stagedInputKeys, round-trips alias catalog jobs through JSON, and supports omitted config in checkVideoJob", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/wf" });
    const sandbox = createFakeSandbox({ "frames/large.png": createLargePng() });
    const stagedKeysSeenAtStart: string[] = [];
    const qualityFake = createAsyncVideoModel({
      modelId: "provider/quality-v1",
      jobId: "job_wf_7",
      webhookSigningSecret: "whsec_live_secret_7",
      operation: { providerJob: "op_serializable_7", version: 1 },
      startWarnings: [{ type: "other", message: "Using fast tier" }],
      onStart() {
        stagedKeysSeenAtStart.push(...storage.keys());
      },
      statuses: [
        { status: "pending" },
        {
          status: "completed",
          videos: [
            { type: "url", url: "https://93.184.216.34/wf-clip.mp4", mediaType: "video/mp4" },
          ],
          warnings: [{ type: "unsupported", feature: "fps", details: "fixed at 24" }],
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
    assert.deepEqual(handle.warnings, ["Using fast tier"]);
    const stagedKey = handle.stagedInputKeys?.[0] as string;
    assert.ok(stagedKey.startsWith("inputs/"));
    assert.ok(stagedKey.endsWith("/start.png"));
    assert.deepEqual(stagedKeysSeenAtStart, [stagedKey]);
    assert.deepEqual(handle.operation, { providerJob: "op_serializable_7", version: 1 });
    assert.equal(qualityFake.startCalls[0].webhookUrl, "https://hooks.example.com/eve/video");
    assert.equal(
      (qualityFake.startCalls[0].headers as Record<string, string>)["idempotency-key"],
      "wf-idem-1",
    );
    const frameImages = qualityFake.startCalls[0].frameImages as readonly {
      readonly image: { readonly type: string; readonly url?: string };
      readonly frameType: string;
    }[];
    assert.equal(frameImages.length, 1);
    assert.equal(frameImages[0].frameType, "first_frame");
    assert.equal(frameImages[0].image.type, "url");
    assert.equal(frameImages[0].image.url, `https://media.example.test/wf/${stagedKey}`);

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
    assert.deepEqual(completedStatus.warnings, ["Unsupported fps: fixed at 24"]);

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
