import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { FatalError, type WorkflowWebhookRequest } from "eve/workflow";

import extension from "../../extension/extension.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
  VideoJobHandle,
} from "../../extension/lib/types.ts";
import {
  MAX_INVALID_WEBHOOK_DELIVERIES,
  WEBHOOK_FALLBACK_POLL_MS,
  runVideoWorkflowTask,
  type VideoWebhookHandle,
  type VideoWorkflowTaskDeps,
} from "../../extension/lib/workflow-runner.ts";
import {
  checkAndPersistStep,
  cleanupStagedInputsStep,
  submitVideoStep,
  verifyAndRespondWebhookStep,
  type CheckAndPersistStepResult,
  type SubmitVideoStepResult,
} from "../../extension/lib/workflow-steps.ts";
import {
  MP4_BYTES,
  PNG_BYTES,
  createAsyncVideoModel,
  createFakeSandbox,
  createFakeStepContext,
  createHttpError,
  createLargePng,
  createSyncVideoModel,
} from "../helpers.ts";

function signWebhookHeader(secret: string, rawBody: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

interface FakeWebhookRequestResult {
  readonly request: WorkflowWebhookRequest;
  readonly responses: Response[];
}

function createFakeWebhookRequest(options: {
  readonly body: string | ReadableStream<Uint8Array>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly respondWithError?: Error;
}): FakeWebhookRequestResult {
  const responses: Response[] = [];
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    body: options.body,
    ...(options.headers !== undefined && { headers: options.headers }),
    ...(typeof options.body !== "string" && { duplex: "half" }),
  };
  const baseRequest = new Request(
    "https://agent.example.com/.well-known/workflow/v1/webhook/tok_step",
    init,
  );
  const request: WorkflowWebhookRequest = Object.assign(baseRequest, {
    async respondWith(response: Response): Promise<void> {
      responses.push(response);
      if (options.respondWithError !== undefined) {
        throw options.respondWithError;
      }
    },
  });
  return { request, responses };
}

interface OpaqueWebhookToken {
  readonly deliveryId: string;
  readonly valid: boolean;
}

interface FakeWebhookController {
  readonly handle: VideoWebhookHandle<OpaqueWebhookToken>;
  readonly disposedCount: () => number;
  push(token: OpaqueWebhookToken): void;
  waitForNextRead(count: number): Promise<void>;
}

function createFakeWebhook(
  url = "https://agent.example.com/.well-known/workflow/v1/webhook/tok_1",
  options: { readonly onGetConflict?: () => Promise<void> | void } = {},
): FakeWebhookController {
  const queued: OpaqueWebhookToken[] = [];
  let pendingNext: ((result: IteratorResult<OpaqueWebhookToken>) => void) | undefined;
  let closed = false;
  let disposed = 0;
  let readCalls = 0;
  const readWaiters: { readonly count: number; readonly resolve: () => void }[] = [];

  const notifyReadWaiters = () => {
    for (let i = readWaiters.length - 1; i >= 0; i -= 1) {
      if (readCalls >= readWaiters[i].count) {
        const waiter = readWaiters.splice(i, 1)[0];
        waiter.resolve();
      }
    }
  };

  const handle: VideoWebhookHandle<OpaqueWebhookToken> = {
    url,
    async getConflict() {
      if (options.onGetConflict !== undefined) {
        await options.onGetConflict();
      }
      return null;
    },
    dispose() {
      disposed += 1;
      closed = true;
      if (pendingNext !== undefined) {
        const resolve = pendingNext;
        pendingNext = undefined;
        resolve({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          readCalls += 1;
          notifyReadWaiters();
          if (queued.length > 0) {
            return Promise.resolve({ done: false, value: queued.shift() as OpaqueWebhookToken });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<OpaqueWebhookToken>>((resolve) => {
            pendingNext = resolve;
          });
        },
      };
    },
  };

  return {
    handle,
    disposedCount: () => disposed,
    push(token) {
      if (pendingNext !== undefined) {
        const resolve = pendingNext;
        pendingNext = undefined;
        resolve({ done: false, value: token });
      } else {
        queued.push(token);
      }
    },
    waitForNextRead(count) {
      if (readCalls >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        readWaiters.push({ count, resolve });
      });
    },
  };
}

interface FakeSleepQueue {
  readonly durations: (string | number | Date)[];
  readonly sleep: (duration: string | number | Date) => Promise<void>;
  waitForCall(count: number): Promise<void>;
  resolveAt(index: number): void;
}

function createFakeSleepQueue(options: { readonly autoResolve?: boolean } = {}): FakeSleepQueue {
  const durations: (string | number | Date)[] = [];
  const resolvers: ((() => void) | undefined)[] = [];
  const callWaiters: { readonly count: number; readonly resolve: () => void }[] = [];

  const notifyWaiters = () => {
    for (let i = callWaiters.length - 1; i >= 0; i -= 1) {
      if (durations.length >= callWaiters[i].count) {
        const waiter = callWaiters.splice(i, 1)[0];
        waiter.resolve();
      }
    }
  };

  return {
    durations,
    sleep(duration) {
      durations.push(duration);
      if (options.autoResolve === true) {
        resolvers.push(undefined);
        notifyWaiters();
        return Promise.resolve();
      }
      const promise = new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      notifyWaiters();
      return promise;
    },
    waitForCall(count) {
      if (durations.length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        callWaiters.push({ count, resolve });
      });
    },
    resolveAt(index) {
      const resolve = resolvers[index];
      assert.ok(resolve !== undefined, `Expected pending sleep resolver at index ${index}.`);
      resolvers[index] = undefined;
      resolve();
    },
  };
}

function createCompletedOutput(
  overrides: {
    readonly model?: string;
    readonly jobId?: string;
    readonly warnings?: readonly string[];
  } = {},
): GenerateVideoToolOutput {
  return {
    status: "completed",
    model: overrides.model ?? "google/veo-3.1-fast-generate-001",
    ...(overrides.jobId !== undefined && { jobId: overrides.jobId }),
    videos: [
      {
        url: "https://media.example.test/videos/clip.mp4",
        storageKey: "videos/clip.mp4",
        mediaType: "video/mp4",
        bytes: MP4_BYTES.byteLength,
      },
    ],
    ...(overrides.warnings !== undefined && { warnings: overrides.warnings }),
  };
}

async function runTaskToCompletion(
  deps: VideoWorkflowTaskDeps<OpaqueWebhookToken>,
  input: GenerateVideoToolInput,
  ctx = createFakeStepContext(),
): Promise<{
  readonly progress: GenerateVideoToolProgress[];
  readonly output: GenerateVideoToolOutput;
}> {
  const generator = runVideoWorkflowTask(deps, input, ctx);
  const progress: GenerateVideoToolProgress[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      return { progress, output: next.value };
    }
    progress.push(next.value);
  }
}

interface WorkflowHarnessOptions {
  readonly metadataUrl?: string;
  readonly webhookUrl?: string;
  readonly modelId?: string;
  readonly jobId?: string;
  readonly webhookSigningSecret?: string;
  readonly stagedInputKeys?: readonly string[];
  readonly useWebhook?: boolean;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly submitResult?: SubmitVideoStepResult;
  readonly submitError?: Error;
  readonly autoResolveSleep?: boolean;
  readonly onSleep?: (duration: string | number | Date, index: number) => void;
  readonly checkAndPersist?: (callIndex: number) => Promise<CheckAndPersistStepResult>;
  readonly verifyAndRespondWebhook?: (
    request: OpaqueWebhookToken,
    secret: string,
  ) => Promise<boolean>;
}

function createWorkflowHarness(options: WorkflowHarnessOptions = {}) {
  const events: string[] = [];
  const webhook = createFakeWebhook(options.webhookUrl, {
    async onGetConflict() {
      events.push("getConflict:start");
      await Promise.resolve();
      events.push("getConflict:done");
    },
  });
  const sleepQueue = createFakeSleepQueue({ autoResolve: options.autoResolveSleep });
  const cleanedKeys: (readonly string[])[] = [];
  const seenWebhookUrls: (string | undefined)[] = [];
  const verifiedDeliveries: { readonly token: OpaqueWebhookToken; readonly secret: string }[] = [];
  let createWebhookCalls = 0;
  let checkCalls = 0;

  const defaultSubmitResult: SubmitVideoStepResult = {
    kind: "async",
    handle: {
      modelId: options.modelId ?? "google/veo-3.1-fast-generate-001",
      operation: { id: `op_${options.jobId ?? "default"}` },
      ...(options.jobId !== undefined && { jobId: options.jobId }),
      ...(options.webhookSigningSecret !== undefined && {
        webhookSigningSecret: options.webhookSigningSecret,
      }),
      ...(options.stagedInputKeys !== undefined && { stagedInputKeys: options.stagedInputKeys }),
      warnings: [],
    },
    useWebhook: options.useWebhook ?? false,
    intervalMs: options.intervalMs ?? 5_000,
    timeoutMs: options.timeoutMs ?? 600_000,
  };

  const deps: VideoWorkflowTaskDeps<OpaqueWebhookToken> = {
    async submit(_input, _ctx, webhookUrlCandidate) {
      events.push("submit");
      seenWebhookUrls.push(webhookUrlCandidate);
      if (options.submitError !== undefined) {
        throw options.submitError;
      }
      return options.submitResult ?? defaultSubmitResult;
    },
    async checkAndPersist() {
      const index = checkCalls;
      checkCalls += 1;
      if (options.checkAndPersist === undefined) {
        assert.fail("Unexpected checkAndPersist call");
      }
      return options.checkAndPersist(index);
    },
    async verifyAndRespondWebhook(request, secret) {
      verifiedDeliveries.push({ token: request, secret });
      if (options.verifyAndRespondWebhook !== undefined) {
        return options.verifyAndRespondWebhook(request, secret);
      }
      return request.valid;
    },
    async cleanup(keys) {
      cleanedKeys.push(keys);
    },
    createWebhook() {
      createWebhookCalls += 1;
      events.push("createWebhook");
      return webhook.handle;
    },
    getWorkflowMetadata: () => ({
      url: options.metadataUrl ?? "https://agent.example.com",
    }),
    sleep(duration) {
      options.onSleep?.(duration, sleepQueue.durations.length);
      return sleepQueue.sleep(duration);
    },
    createFatalError: (message) => new FatalError(message),
  };

  return {
    deps,
    webhook,
    sleepQueue,
    events,
    cleanedKeys,
    seenWebhookUrls,
    verifiedDeliveries,
    createWebhookCalls: () => createWebhookCalls,
    checkCalls: () => checkCalls,
  };
}

afterEach(() => {
  extension({});
});

describe("workflow step helpers", () => {
  test("submitVideoStep enables webhook mode for webhook-capable models with public HTTPS webhook URLs", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/wf" });
    const sandbox = createFakeSandbox({ "frames/opening.png": createLargePng() });
    const fake = createAsyncVideoModel({
      modelId: "google/veo-3.1-fast-generate-001",
      handleWebhookOption: true,
      jobId: "job_wh_step_1",
      webhookSigningSecret: "whsec_step_live_1",
    });

    extension({
      model: fake.model,
      storage,
      webhook: "auto",
      poll: { intervalMs: 2_500, timeoutMs: 120_000 },
    });

    const webhookUrl = "https://agent.example.com/.well-known/workflow/v1/webhook/tok_abc";
    const result = await submitVideoStep(
      { prompt: "Sunrise over mountains", start: "frames/opening.png" },
      createFakeStepContext({ sandbox, sessionId: "sess-wh", callId: "call-wh" }),
      webhookUrl,
    );

    assert.equal(result.kind, "async");
    if (result.kind !== "async") {
      assert.fail("Expected async submit result.");
    }
    assert.equal(result.useWebhook, true);
    assert.equal(result.handle.modelId, "google/veo-3.1-fast-generate-001");
    assert.equal(result.handle.jobId, "job_wh_step_1");
    assert.equal(result.handle.webhookSigningSecret, "whsec_step_live_1");
    assert.equal(result.handle.stagedInputKeys?.length, 1);
    assert.ok(result.handle.stagedInputKeys?.[0].startsWith("inputs/"));
    assert.equal(result.intervalMs, 2_500);
    assert.equal(result.timeoutMs, 120_000);
    assert.equal(fake.startCalls.length, 1);
    assert.equal(fake.startCalls[0].webhookUrl, webhookUrl);
    const headers = fake.startCalls[0].headers as Record<string, string>;
    assert.equal(headers["idempotency-key"].length, 64);
  });

  test("submitVideoStep omits webhookUrl for local URLs, non-webhook models, and webhook: never", async () => {
    const cases: readonly {
      readonly name: string;
      readonly webhookConfig: "auto" | "never";
      readonly handleWebhookOption: boolean;
      readonly webhookUrlCandidate: string;
    }[] = [
      {
        name: "local eve dev webhook URL",
        webhookConfig: "auto",
        handleWebhookOption: true,
        webhookUrlCandidate: "http://127.0.0.1:3000/.well-known/workflow/v1/webhook/tok_local",
      },
      {
        name: "model without handleWebhookOption",
        webhookConfig: "auto",
        handleWebhookOption: false,
        webhookUrlCandidate: "https://agent.example.com/.well-known/workflow/v1/webhook/tok_direct",
      },
      {
        name: "webhook config set to never",
        webhookConfig: "never",
        handleWebhookOption: true,
        webhookUrlCandidate: "https://agent.example.com/.well-known/workflow/v1/webhook/tok_never",
      },
    ];

    for (const tc of cases) {
      const storage = inMemory();
      const fake = createAsyncVideoModel({
        handleWebhookOption: tc.handleWebhookOption,
        webhookSigningSecret: "whsec_should_not_use",
      });
      extension({
        model: fake.model,
        storage,
        webhook: tc.webhookConfig,
      });

      const result = await submitVideoStep(
        { prompt: tc.name },
        createFakeStepContext(),
        tc.webhookUrlCandidate,
      );

      assert.equal(result.kind, "async", tc.name);
      if (result.kind !== "async") {
        assert.fail(`Expected async submit result for ${tc.name}`);
      }
      assert.equal(result.useWebhook, false, tc.name);
      assert.equal(fake.startCalls.length, 1, tc.name);
      assert.equal(fake.startCalls[0].webhookUrl, undefined, tc.name);
    }
  });

  test("submitVideoStep completes doGenerate-only models directly without async polling", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/sync" });
    const syncFake = createSyncVideoModel({
      modelId: "test/sync-workflow-step",
      videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
    });

    extension({ model: syncFake.model, storage });

    const result = await submitVideoStep(
      { prompt: "Direct sync render" },
      createFakeStepContext(),
      "https://agent.example.com/.well-known/workflow/v1/webhook/tok_sync",
    );

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") {
      assert.fail("Expected completed submit result.");
    }
    assert.equal(result.output.status, "completed");
    assert.equal(result.output.model, "test/sync-workflow-step");
    assert.equal(result.output.videos.length, 1);
    const stored = await storage.get({
      key: result.output.videos[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(stored?.data, MP4_BYTES);
  });

  test("classifies deterministic errors and terminal provider errors as FatalError while letting transient 503 retry", async () => {
    const storage = inMemory();

    const noDestinationModel = createAsyncVideoModel();
    extension({ model: noDestinationModel.model, storage: false });
    await assert.rejects(
      () => submitVideoStep({ prompt: "Missing destination" }, createFakeStepContext()),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /No video output destination is configured/);
        return true;
      },
    );
    assert.equal(noDestinationModel.startCalls.length, 0);

    const allowedModel = createAsyncVideoModel({ modelId: "test/allowed" });
    extension({ model: allowedModel.model, models: { allowed: allowedModel.model }, storage });
    await assert.rejects(
      () =>
        submitVideoStep({ prompt: "Wrong model", model: "disallowed" }, createFakeStepContext()),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /is not allowed/);
        return true;
      },
    );

    const badRequestStartModel = createAsyncVideoModel({
      onStart() {
        throw createHttpError(400, "Invalid video duration");
      },
    });
    extension({ model: badRequestStartModel.model, storage });
    await assert.rejects(
      () => submitVideoStep({ prompt: "400 start" }, createFakeStepContext()),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /Invalid video duration/);
        return true;
      },
    );

    const transientStartModel = createAsyncVideoModel({
      onStart() {
        throw createHttpError(503, "Gateway temporarily unavailable");
      },
    });
    extension({ model: transientStartModel.model, storage });
    await assert.rejects(
      () => submitVideoStep({ prompt: "503 start" }, createFakeStepContext()),
      (error: unknown) => {
        assert.equal(error instanceof FatalError, false);
        assert.ok(error instanceof Error);
        assert.match(error.message, /Gateway temporarily unavailable/);
        return true;
      },
    );

    const statusModel = createAsyncVideoModel({
      modelId: "test/status-classification",
      statuses: [
        { status: "error", error: "Safety policy rejected prompt" },
        async () => {
          throw createHttpError(400, "Unknown operation handle");
        },
        async () => {
          throw createHttpError(503, "Status endpoint overloaded");
        },
      ],
      repeatLastStatus: false,
    });
    extension({ model: statusModel.model, storage });
    const handle: VideoJobHandle = {
      modelId: "test/status-classification",
      operation: { id: "op_err" },
      warnings: [],
    };

    await assert.rejects(
      () => checkAndPersistStep({ prompt: "Terminal error" }, createFakeStepContext(), handle),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /Safety policy rejected prompt/);
        return true;
      },
    );

    await assert.rejects(
      () => checkAndPersistStep({ prompt: "400 status" }, createFakeStepContext(), handle),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /Unknown operation handle/);
        return true;
      },
    );

    await assert.rejects(
      () => checkAndPersistStep({ prompt: "503 status" }, createFakeStepContext(), handle),
      (error: unknown) => {
        assert.equal(error instanceof FatalError, false);
        assert.ok(error instanceof Error);
        assert.match(error.message, /Status endpoint overloaded/);
        return true;
      },
    );
  });

  test("verifyAndRespondWebhookStep validates signatures, bounds body size, skips body when header missing, and tolerates client disconnect", async () => {
    const secret = "whsec_verify_step_secret";
    const rawBody = JSON.stringify({ event: "video.completed", jobId: "job_verify_1" });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const validHeader = signWebhookHeader(secret, rawBody, nowSeconds);
    const forgedHeader = signWebhookHeader("whsec_wrong_secret", rawBody, nowSeconds);

    const validDelivery = createFakeWebhookRequest({
      body: rawBody,
      headers: { "x-ai-gateway-signature": validHeader },
    });
    assert.equal(await verifyAndRespondWebhookStep(validDelivery.request, secret), true);
    assert.equal(validDelivery.responses.length, 1);
    assert.equal(validDelivery.responses[0].status, 204);

    let missingHeaderBodyReads = 0;
    let missingHeaderBodyCancelled = false;
    const unconsumedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        missingHeaderBodyReads += 1;
        controller.enqueue(new TextEncoder().encode(rawBody));
        controller.close();
      },
      cancel() {
        missingHeaderBodyCancelled = true;
      },
    });
    const missingHeaderDelivery = createFakeWebhookRequest({ body: unconsumedStream });
    assert.equal(await verifyAndRespondWebhookStep(missingHeaderDelivery.request, secret), false);
    assert.equal(missingHeaderDelivery.responses.length, 1);
    assert.equal(missingHeaderDelivery.responses[0].status, 401);
    assert.equal(missingHeaderBodyReads, 0);
    assert.equal(missingHeaderBodyCancelled, true);

    const forgedDelivery = createFakeWebhookRequest({
      body: rawBody,
      headers: { "x-ai-gateway-signature": forgedHeader },
    });
    assert.equal(await verifyAndRespondWebhookStep(forgedDelivery.request, secret), false);
    assert.equal(forgedDelivery.responses.length, 1);
    assert.equal(forgedDelivery.responses[0].status, 401);

    let oversizedChunksRead = 0;
    let oversizedCancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        oversizedChunksRead += 1;
        controller.enqueue(new Uint8Array(20 * 1024));
        if (oversizedChunksRead >= 10) {
          controller.close();
        }
      },
      cancel() {
        oversizedCancelled = true;
      },
    });
    const oversizedStreamDelivery = createFakeWebhookRequest({
      body: oversizedStream,
      headers: { "x-ai-gateway-signature": validHeader },
    });
    assert.equal(await verifyAndRespondWebhookStep(oversizedStreamDelivery.request, secret), false);
    assert.equal(oversizedStreamDelivery.responses.length, 1);
    assert.equal(oversizedStreamDelivery.responses[0].status, 413);
    assert.equal(oversizedCancelled, true);
    assert.ok(oversizedChunksRead <= 4);

    let declaredOversizeReads = 0;
    let declaredOversizeCancelled = false;
    const declaredOversizeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredOversizeReads += 1;
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
      cancel() {
        declaredOversizeCancelled = true;
      },
    });
    const declaredOversizeDelivery = createFakeWebhookRequest({
      body: declaredOversizeStream,
      headers: {
        "x-ai-gateway-signature": validHeader,
        "content-length": String(70 * 1024),
      },
    });
    assert.equal(
      await verifyAndRespondWebhookStep(declaredOversizeDelivery.request, secret),
      false,
    );
    assert.equal(declaredOversizeDelivery.responses.length, 1);
    assert.equal(declaredOversizeDelivery.responses[0].status, 413);
    assert.equal(declaredOversizeReads, 0);
    assert.equal(declaredOversizeCancelled, true);

    const disconnectedDelivery = createFakeWebhookRequest({
      body: rawBody,
      headers: { "x-ai-gateway-signature": validHeader },
      respondWithError: new Error("client disconnected"),
    });
    assert.equal(await verifyAndRespondWebhookStep(disconnectedDelivery.request, secret), true);
    assert.equal(disconnectedDelivery.responses.length, 1);
    assert.equal(disconnectedDelivery.responses[0].status, 204);
  });

  test("checkAndPersistStep returns pending until complete, then persists to storage and sandbox with combined warnings", async () => {
    const storage = inMemory({ baseUrl: "https://media.example.test/cp" });
    const sandbox = createFakeSandbox();
    const fake = createAsyncVideoModel({
      modelId: "test/check-persist",
      statuses: [
        {
          status: "pending",
          warnings: [{ type: "other", message: "Still queued" }],
        },
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
          warnings: [
            { type: "other", message: "Start warning" },
            { type: "unsupported", feature: "fps", details: "fixed at 24" },
          ],
        },
      ],
    });

    extension({ model: fake.model, storage });
    const handle: VideoJobHandle = {
      modelId: "test/check-persist",
      operation: { id: "op_cp_1" },
      jobId: "job_cp_1",
      warnings: ["Start warning"],
    };
    const input: GenerateVideoToolInput = { prompt: "Persist step", path: "videos/final.mp4" };
    const ctx = createFakeStepContext({ sandbox, sessionId: "sess-cp" });

    const pending = await checkAndPersistStep(input, ctx, handle);
    assert.deepEqual(pending, { status: "pending", warnings: ["Still queued"] });
    assert.deepEqual(storage.keys(), []);
    assert.equal(sandbox.files.size, 0);

    const completed = await checkAndPersistStep(input, ctx, handle);
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed") {
      assert.fail("Expected completed checkAndPersistStep result.");
    }
    assert.equal(completed.output.status, "completed");
    assert.equal(completed.output.model, "test/check-persist");
    assert.equal(completed.output.jobId, "job_cp_1");
    assert.equal(completed.output.videos.length, 1);
    assert.equal(completed.output.videos[0].path, "videos/final.mp4");
    assert.equal(completed.output.videos[0].bytes, MP4_BYTES.byteLength);
    assert.ok(completed.output.videos[0].url?.startsWith("https://media.example.test/cp/videos/"));
    assert.deepEqual(completed.output.warnings, ["Start warning", "Unsupported fps: fixed at 24"]);

    const stored = await storage.get({
      key: completed.output.videos[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(stored?.data, MP4_BYTES);
    assert.deepEqual(sandbox.files.get("videos/final.mp4"), MP4_BYTES);
  });

  test("cleanupStagedInputsStep deletes only staged input keys from configured storage", async () => {
    const storage = inMemory();
    const signal = new AbortController().signal;
    await storage.put({
      key: "inputs/run-1/start.png",
      data: PNG_BYTES,
      mediaType: "image/png",
      filename: "start.png",
      signal,
    });
    await storage.put({
      key: "inputs/run-1/end.png",
      data: PNG_BYTES,
      mediaType: "image/png",
      filename: "end.png",
      signal,
    });
    await storage.put({
      key: "videos/keep.mp4",
      data: MP4_BYTES,
      mediaType: "video/mp4",
      filename: "keep.mp4",
      signal,
    });

    extension({ storage });

    await cleanupStagedInputsStep(["inputs/run-1/start.png", "inputs/run-1/end.png"]);
    assert.deepEqual(storage.keys(), ["videos/keep.mp4"]);
  });
});

describe("runVideoWorkflowTask state machine", () => {
  test("awaits getConflict before submit, passes opaque request token to verifyAndRespondWebhook, completes, disposes webhook, and cleans up staged inputs", async () => {
    const completedOutput = createCompletedOutput({ jobId: "job_wh_happy" });
    const token: OpaqueWebhookToken = { deliveryId: "del_happy_1", valid: true };
    const harness = createWorkflowHarness({
      metadataUrl: "https://agent.example.com",
      jobId: "job_wh_happy",
      webhookSigningSecret: "whsec_happy",
      stagedInputKeys: ["inputs/happy/start.png"],
      useWebhook: true,
      checkAndPersist: async () => ({ status: "completed", output: completedOutput }),
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Webhook happy path" });
    await harness.sleepQueue.waitForCall(1);
    assert.deepEqual(harness.events, [
      "createWebhook",
      "getConflict:start",
      "getConflict:done",
      "submit",
    ]);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS]);

    harness.webhook.push(token);

    const { progress, output } = await taskPromise;
    assert.deepEqual(harness.seenWebhookUrls, [harness.webhook.handle.url]);
    assert.deepEqual(harness.verifiedDeliveries, [{ token, secret: "whsec_happy" }]);
    assert.equal(harness.checkCalls(), 1);
    assert.deepEqual(output, completedOutput);
    assert.deepEqual(progress, [
      {
        status: "generating",
        model: "google/veo-3.1-fast-generate-001",
        jobId: "job_wh_happy",
        elapsedSeconds: 0,
        attempt: 1,
      },
    ]);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.deepEqual(harness.cleanedKeys, [["inputs/happy/start.png"]]);
  });

  test("rejects forged webhook without emitting extra progress, bumping attempt, or resetting fallback sleep, then completes on valid delivery", async () => {
    const completedOutput = createCompletedOutput({ jobId: "job_forged_then_valid" });
    const harness = createWorkflowHarness({
      jobId: "job_forged_then_valid",
      webhookSigningSecret: "whsec_secret",
      useWebhook: true,
      checkAndPersist: async () => ({ status: "completed", output: completedOutput }),
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Forged then valid" });
    await harness.sleepQueue.waitForCall(1);

    harness.webhook.push({ deliveryId: "forged-1", valid: false });
    await harness.webhook.waitForNextRead(2);
    assert.equal(harness.checkCalls(), 0);
    assert.equal(harness.webhook.disposedCount(), 0);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS]);

    harness.webhook.push({ deliveryId: "valid-2", valid: true });

    const { progress, output } = await taskPromise;
    assert.deepEqual(output, completedOutput);
    assert.equal(harness.checkCalls(), 1);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].status === "generating" ? progress[0].attempt : -1, 1);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS]);
    assert.equal(harness.webhook.disposedCount(), 1);
  });

  test("disposes webhook and falls back to durable sleep polling after MAX_INVALID_WEBHOOK_DELIVERIES forged requests", async () => {
    const completedOutput = createCompletedOutput({ jobId: "job_spam_cap" });
    const harness = createWorkflowHarness({
      jobId: "job_spam_cap",
      webhookSigningSecret: "whsec_spam",
      stagedInputKeys: ["inputs/spam.png"],
      useWebhook: true,
      checkAndPersist: async () => ({ status: "completed", output: completedOutput }),
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Spam fallback" });
    await harness.sleepQueue.waitForCall(1);

    for (let i = 0; i < MAX_INVALID_WEBHOOK_DELIVERIES; i += 1) {
      harness.webhook.push({ deliveryId: `forged-${i}`, valid: false });
    }

    await harness.sleepQueue.waitForCall(2);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.equal(harness.checkCalls(), 0);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS, 5_000]);

    harness.sleepQueue.resolveAt(1);
    const { progress, output } = await taskPromise;
    assert.deepEqual(output, completedOutput);
    assert.equal(harness.checkCalls(), 1);
    assert.equal(progress.length, 2);
    assert.equal(progress[0].status === "generating" ? progress[0].attempt : -1, 1);
    assert.equal(progress[1].status === "generating" ? progress[1].attempt : -1, 2);
  });

  test("disposes webhook and falls back to durable sleep polling when checkAndPersist is still pending after a valid webhook", async () => {
    const completedOutput = createCompletedOutput({
      jobId: "job_eventual",
      warnings: ["Done"],
    });
    const harness = createWorkflowHarness({
      jobId: "job_eventual",
      webhookSigningSecret: "whsec_eventual",
      stagedInputKeys: ["inputs/eventual.png"],
      useWebhook: true,
      checkAndPersist: async (index) =>
        index === 0
          ? { status: "pending", warnings: ["Replicating asset"] }
          : { status: "completed", output: completedOutput },
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Eventual consistency" });
    await harness.sleepQueue.waitForCall(1);

    harness.webhook.push({ deliveryId: "valid-early", valid: true });
    await harness.sleepQueue.waitForCall(2);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.equal(harness.checkCalls(), 1);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS, 5_000]);

    harness.sleepQueue.resolveAt(1);
    const { output } = await taskPromise;
    assert.equal(harness.checkCalls(), 2);
    assert.deepEqual(output.warnings, ["Done", "Replicating asset"]);
    assert.deepEqual(harness.cleanedKeys, [["inputs/eventual.png"]]);
  });

  test("discovers completion on safety-net fallback poll when webhook never arrives and disposes webhook", async () => {
    const harness = createWorkflowHarness({
      jobId: "job_fallback_1",
      webhookSigningSecret: "whsec_fallback",
      stagedInputKeys: ["inputs/fallback.png"],
      useWebhook: true,
      timeoutMs: 300_000,
      checkAndPersist: async (index) =>
        index === 0
          ? { status: "pending", warnings: ["Provider queue busy"] }
          : {
              status: "completed",
              output: createCompletedOutput({
                jobId: "job_fallback_1",
                warnings: ["Clip normalized"],
              }),
            },
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Blocked webhook fallback" });
    await harness.sleepQueue.waitForCall(1);
    assert.deepEqual(harness.sleepQueue.durations, [WEBHOOK_FALLBACK_POLL_MS]);
    harness.sleepQueue.resolveAt(0);

    await harness.sleepQueue.waitForCall(2);
    assert.deepEqual(harness.sleepQueue.durations, [
      WEBHOOK_FALLBACK_POLL_MS,
      WEBHOOK_FALLBACK_POLL_MS,
    ]);
    harness.sleepQueue.resolveAt(1);

    const { progress, output } = await taskPromise;
    assert.equal(harness.checkCalls(), 2);
    assert.equal(progress.length, 2);
    assert.equal(progress[0].status === "generating" ? progress[0].elapsedSeconds : -1, 0);
    assert.equal(progress[1].status === "generating" ? progress[1].elapsedSeconds : -1, 60);
    assert.deepEqual(output.warnings, ["Clip normalized", "Provider queue busy"]);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.deepEqual(harness.cleanedKeys, [["inputs/fallback.png"]]);
  });

  test("does not call createWebhook on local http://127.0.0.1:3000 metadata and runs durable polling to completion", async () => {
    const harness = createWorkflowHarness({
      metadataUrl: "http://127.0.0.1:3000",
      jobId: "job_local_dev",
      stagedInputKeys: ["inputs/poll.png"],
      useWebhook: false,
      timeoutMs: 60_000,
      autoResolveSleep: true,
      checkAndPersist: async (index) =>
        index < 2
          ? { status: "pending", warnings: ["Rendering"] }
          : {
              status: "completed",
              output: createCompletedOutput({ jobId: "job_local_dev" }),
            },
    });

    const { progress, output } = await runTaskToCompletion(harness.deps, {
      prompt: "Local dev poll",
    });

    assert.equal(harness.createWebhookCalls(), 0);
    assert.deepEqual(harness.seenWebhookUrls, [undefined]);
    assert.deepEqual(harness.sleepQueue.durations, [5_000, 5_000, 5_000]);
    assert.equal(harness.checkCalls(), 3);
    assert.deepEqual(progress, [
      {
        status: "generating",
        model: "google/veo-3.1-fast-generate-001",
        jobId: "job_local_dev",
        elapsedSeconds: 0,
        attempt: 1,
      },
      {
        status: "generating",
        model: "google/veo-3.1-fast-generate-001",
        jobId: "job_local_dev",
        elapsedSeconds: 5,
        attempt: 2,
      },
      {
        status: "generating",
        model: "google/veo-3.1-fast-generate-001",
        jobId: "job_local_dev",
        elapsedSeconds: 10,
        attempt: 3,
      },
    ]);
    assert.deepEqual(output.warnings, ["Rendering"]);
    assert.deepEqual(harness.cleanedKeys, [["inputs/poll.png"]]);
  });

  test("disposes created webhook immediately before sleeping when HTTPS host runs polling-only mode", async () => {
    let disposedBeforeFirstSleep = false;
    const harness = createWorkflowHarness({
      metadataUrl: "https://agent.example.com",
      jobId: "job_https_poll_only",
      useWebhook: false,
      timeoutMs: 60_000,
      autoResolveSleep: true,
      onSleep(_duration, index) {
        if (index === 0) {
          disposedBeforeFirstSleep = harness.webhook.disposedCount() === 1;
        }
      },
      checkAndPersist: async () => ({
        status: "completed",
        output: createCompletedOutput({ jobId: "job_https_poll_only" }),
      }),
    });

    const { output } = await runTaskToCompletion(harness.deps, {
      prompt: "HTTPS polling fallback",
    });
    assert.equal(harness.createWebhookCalls(), 1);
    assert.equal(disposedBeforeFirstSleep, true);
    assert.equal(output.jobId, "job_https_poll_only");
    assert.equal(harness.webhook.disposedCount(), 1);
  });

  test("returns immediately with zero progress yields and disposes webhook when submit completes synchronously", async () => {
    const syncOutput = createCompletedOutput({ model: "test/sync-direct" });
    const harness = createWorkflowHarness({
      metadataUrl: "https://agent.example.com",
      submitResult: { kind: "completed", output: syncOutput },
    });

    const { progress, output } = await runTaskToCompletion(harness.deps, {
      prompt: "Sync doGenerate completion",
    });

    assert.deepEqual(output, syncOutput);
    assert.deepEqual(progress, []);
    assert.equal(harness.createWebhookCalls(), 1);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.equal(harness.checkCalls(), 0);
    assert.deepEqual(harness.sleepQueue.durations, []);
    assert.deepEqual(harness.cleanedKeys, []);
  });

  test("disposes webhook and cleans up stagedInputKeys when checkAndPersist throws FatalError", async () => {
    const harness = createWorkflowHarness({
      metadataUrl: "https://agent.example.com",
      jobId: "job_fatal_check",
      webhookSigningSecret: "whsec_fatal",
      stagedInputKeys: ["inputs/fatal.png"],
      useWebhook: true,
      checkAndPersist: async () => {
        throw new FatalError("Provider rejected generation");
      },
    });

    const taskPromise = runTaskToCompletion(harness.deps, { prompt: "Fatal status error" });
    await harness.sleepQueue.waitForCall(1);
    harness.webhook.push({ deliveryId: "del-fatal", valid: true });

    await assert.rejects(
      () => taskPromise,
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /Provider rejected generation/);
        return true;
      },
    );
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.deepEqual(harness.cleanedKeys, [["inputs/fatal.png"]]);
  });

  test("disposes webhook without invoking cleanup when submit throws", async () => {
    const harness = createWorkflowHarness({
      metadataUrl: "https://agent.example.com",
      submitError: new FatalError("Missing output destination"),
    });

    await assert.rejects(
      () => runTaskToCompletion(harness.deps, { prompt: "Submit failure" }),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /Missing output destination/);
        return true;
      },
    );
    assert.equal(harness.createWebhookCalls(), 1);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.deepEqual(harness.cleanedKeys, []);
    assert.equal(harness.checkCalls(), 0);
  });

  test("calls checkAndPersist at least once before throwing FatalError timeout when intervalMs >= timeoutMs", async () => {
    const harness = createWorkflowHarness({
      metadataUrl: "http://127.0.0.1:3000",
      modelId: "test/edge-interval",
      jobId: "job_edge_9",
      useWebhook: false,
      intervalMs: 10_000,
      timeoutMs: 4_000,
      autoResolveSleep: true,
      checkAndPersist: async () => ({ status: "pending", warnings: [] }),
    });

    await assert.rejects(
      () => runTaskToCompletion(harness.deps, { prompt: "Edge interval timeout" }),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /test\/edge-interval/);
        assert.match(error.message, /job_edge_9/);
        assert.match(error.message, /timed out after 4000ms/);
        return true;
      },
    );
    assert.ok(harness.checkCalls() >= 1);
    assert.deepEqual(harness.sleepQueue.durations, [2_000, 2_000]);
  });

  test("wakes immediately on ctx.abortSignal cancellation mid-wait, disposes webhook, and cleans up staged inputs", async () => {
    const controller = new AbortController();
    const harness = createWorkflowHarness({
      jobId: "job_abort_1",
      webhookSigningSecret: "whsec_abort",
      stagedInputKeys: ["inputs/abort.png"],
      useWebhook: true,
      checkAndPersist: async () => ({ status: "pending", warnings: [] }),
    });

    const taskPromise = runTaskToCompletion(
      harness.deps,
      { prompt: "Abort mid-wait" },
      createFakeStepContext({ signal: controller.signal }),
    );
    await harness.sleepQueue.waitForCall(1);

    controller.abort(new Error("user cancelled workflow task"));

    await assert.rejects(() => taskPromise, /user cancelled workflow task/);
    assert.equal(harness.checkCalls(), 0);
    assert.equal(harness.webhook.disposedCount(), 1);
    assert.deepEqual(harness.cleanedKeys, [["inputs/abort.png"]]);
  });

  test("throws FatalError naming model and jobId on timeout and cleans up staged inputs", async () => {
    const harness = createWorkflowHarness({
      metadataUrl: "http://127.0.0.1:3000",
      modelId: "google/veo-timeout",
      jobId: "job_timeout_77",
      stagedInputKeys: ["inputs/timeout-a.png", "inputs/timeout-b.png"],
      useWebhook: false,
      intervalMs: 5_000,
      timeoutMs: 10_000,
      autoResolveSleep: true,
      checkAndPersist: async () => ({ status: "pending", warnings: [] }),
    });

    await assert.rejects(
      () => runTaskToCompletion(harness.deps, { prompt: "Always pending" }),
      (error: unknown) => {
        assert.ok(error instanceof FatalError);
        assert.match(error.message, /google\/veo-timeout/);
        assert.match(error.message, /job_timeout_77/);
        assert.match(error.message, /timed out after 10000ms/);
        return true;
      },
    );
    assert.deepEqual(harness.cleanedKeys, [["inputs/timeout-a.png", "inputs/timeout-b.png"]]);
  });
});
