import assert, { deepEqual as deq, equal as eq } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { always, type ApprovalConfiguration } from "eve/tools/approval";
import { FatalError, type WorkflowWebhookRequest } from "eve/workflow";

import extension from "../../extension/extension.ts";
import { createIdempotencyKey, isTransientProviderError } from "../../extension/lib/engine.ts";
import { downloadVideoBytes } from "../../extension/lib/media.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import type { VideoStorage } from "../../extension/lib/storage/types.ts";
import * as T from "../../extension/lib/tools.ts";
import type * as Types from "../../extension/lib/types.ts";
import * as R from "../../extension/lib/workflow-runner.ts";
import * as S from "../../extension/lib/workflow-steps.ts";
import * as H from "../helpers.ts";

const {
  createAsyncVideoModel: mkAsync,
  createSyncVideoModel: mkSync,
  createFakeSandbox: mkSb,
  createFakeStepContext: mkCtx,
} = H;
const SIG = new AbortController().signal;
const C = "https://cdn.example.com";
const SRC = `${C}/clip.mp4`;
const GROK = "spacexai/grok-imagine-video";
const WH_URL = "https://agent.example.com/.well-known/workflow/v1/webhook/tok";
const signHdr = (sec: string, body: string, ts: number) =>
  `t=${ts},v1=${createHmac("sha256", sec).update(`${ts}.${body}`, "utf8").digest("hex")}`;
const putFile = (s: VideoStorage, key: string, data = H.MP4_BYTES, mediaType = "video/mp4") =>
  s.put({ key, data, mediaType, filename: key.split("/").pop()!, signal: SIG });
const sub = (inp: Types.GenerateVideoToolInput, ctx?: Parameters<typeof mkCtx>[0], wh?: string) =>
  S.submitVideoStep(inp, mkCtx(ctx), wh);
const ref = (url: string, mediaType: string) => ({ type: "url", url, mediaType });
const xaiOpts = (extra: Record<string, unknown>) => ({
  xai: { style: "cinematic", ...extra },
  other: { trace: "yes" },
});

async function failStep(fn: () => Promise<unknown>, re: RegExp, fatal = true) {
  await assert.rejects(fn, (err: unknown) => {
    eq(err instanceof FatalError, fatal);
    assert.ok(err instanceof Error);
    assert.match(err.message, re);
    return true;
  });
}

function fakeReq(
  body: string | ReadableStream<Uint8Array>,
  headers?: Record<string, string>,
  err?: Error,
) {
  const responses: Response[] = [];
  const init: RequestInit & { duplex?: "half" } = { method: "POST", body };
  if (headers) init.headers = headers;
  if (typeof body !== "string") init.duplex = "half";
  const req: WorkflowWebhookRequest = Object.assign(new Request(WH_URL, init), {
    async respondWith(res: Response) {
      responses.push(res);
      if (err) throw err;
    },
  });
  return { req, responses };
}

type Token = { id: string; valid: boolean };
const outOf = (jobId = "j1", warnings?: readonly string[]): Types.GenerateVideoToolOutput => ({
  status: "completed",
  model: "bytedance/seedance-2.5-flash",
  videos: [
    {
      url: "https://media.test/c.mp4",
      storageKey: "v/c.mp4",
      mediaType: "video/mp4",
      bytes: H.MP4_BYTES.byteLength,
    },
  ],
  jobId,
  ...(warnings && { warnings }),
});
const pendingRes = (warnings: string[] = []): S.CheckAndPersistStepResult => ({
  status: "pending",
  warnings,
});
const doneRes = (id = "j1", w?: string[]): S.CheckAndPersistStepResult => ({
  status: "completed",
  output: outOf(id, w),
});

function createHarness(
  o: Partial<{
    metadataUrl: string;
    staged: readonly string[];
    useWebhook: boolean;
    intervalMs: number;
    timeoutMs: number;
    submitResult: S.SubmitVideoStepResult;
    submitError: Error;
    autoSleep: boolean;
    check: (i: number) => Promise<S.CheckAndPersistStepResult>;
  }> = {},
) {
  const events: string[] = [];
  const cleaned: (readonly string[])[] = [];
  const sleeps: (string | number | Date)[] = [];
  const queue: Token[] = [];
  const sleepRes: ((() => void) | undefined)[] = [];
  const waiters: { get: () => number; n: number; r: () => void }[] = [];
  let pending: ((r: IteratorResult<Token>) => void) | undefined;
  let [closed, disposed, reads, whCalls, checks] = [false, 0, 0, 0, 0];
  const flush = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1)
      if (waiters[i].get() >= waiters[i].n) waiters.splice(i, 1)[0].r();
  };
  const wait = (get: () => number, n: number) =>
    get() >= n ? Promise.resolve() : new Promise<void>((r) => void waiters.push({ get, n, r }));
  const deliver = (res: IteratorResult<Token>) => {
    if (!pending) return false;
    const r = pending;
    pending = undefined;
    r(res);
    return true;
  };
  const webhook: R.VideoWebhookHandle<Token> = {
    url: WH_URL,
    async getConflict() {
      events.push("getConflict:start");
      await Promise.resolve();
      events.push("getConflict:done");
      return null;
    },
    dispose() {
      disposed += 1;
      closed = true;
      deliver({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]: () => ({
      next() {
        reads += 1;
        flush();
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((r) => void (pending = r));
      },
    }),
  };
  const handle: Types.VideoJobHandle = {
    modelId: "bytedance/seedance-2.5-flash",
    operation: { id: "op_1" },
    jobId: "j1",
    webhookSigningSecret: "whsec_1",
    warnings: [],
    ...(o.staged && { stagedInputKeys: o.staged }),
  };
  const deps: R.VideoWorkflowTaskDeps<Token> = {
    async submit() {
      events.push("submit");
      if (o.submitError) throw o.submitError;
      return (
        o.submitResult ?? {
          kind: "async",
          handle,
          useWebhook: o.useWebhook ?? true,
          intervalMs: o.intervalMs ?? 5_000,
          timeoutMs: o.timeoutMs ?? 600_000,
        }
      );
    },
    checkAndPersist: async () => (o.check ? o.check(checks++) : (checks++, doneRes())),
    verifyAndRespondWebhook: async (req) => req.valid,
    cleanup: async (keys) => void cleaned.push(keys),
    createWebhook: () => (whCalls++, events.push("createWebhook"), webhook),
    getWorkflowMetadata: () => ({ url: o.metadataUrl ?? "https://agent.example.com" }),
    sleep(d) {
      sleeps.push(d);
      if (o.autoSleep) return (sleepRes.push(undefined), flush(), Promise.resolve());
      const p = new Promise<void>((r) => void sleepRes.push(r));
      flush();
      return p;
    },
  };
  return {
    deps,
    events,
    cleaned,
    sleeps,
    disposed: () => disposed,
    whCalls: () => whCalls,
    checks: () => checks,
    push: (t: Token) => void (deliver({ done: false, value: t }) || queue.push(t)),
    waitRead: (n: number) => wait(() => reads, n),
    waitSleep: (n: number) => wait(() => sleeps.length, n),
    wakeSleep: (i: number) => (
      assert.ok(sleepRes[i]),
      sleepRes[i]!(),
      void (sleepRes[i] = undefined)
    ),
  };
}

async function runTask(deps: R.VideoWorkflowTaskDeps<Token>, ctx = H.createFakeStepContext()) {
  const gen = R.runVideoWorkflowTask(deps, { prompt: "Run" }, ctx);
  const progress: Types.GenerateVideoToolProgress[] = [];
  for (;;) {
    const s = await gen.next();
    if (s.done) return { progress, output: s.value };
    progress.push(s.value);
  }
}

afterEach(() => {
  extension({});
});

describe("pre-flight gating before paid submission", () => {
  test("blocks invalid inputs, missing destination/sandbox, limits, and non-HTTP schemes with zero doStart calls", async () => {
    const storage = inMemory();
    const sb = mkSb({
      "in/frame.png": H.PNG_BYTES,
      "in/empty.png": new Uint8Array(0),
      "in/big.png": new Uint8Array(64).fill(0x89),
      "in/text.bin": new TextEncoder().encode("not media"),
    });
    type Row = [
      Partial<Types.GenerateVideoToolInput>,
      Partial<Types.VideoExtensionConfig>,
      RegExp,
      H.FakeSandbox?,
    ];
    const rows: Row[] = [
      [{}, { storage: false }, /No video output destination/],
      [{ path: "o.mp4" }, { storage: false }, /requires an agent sandbox/],
      [{ start: "in/frame.png" }, {}, /requires an agent sandbox/],
      [{ mode: "edit" }, {}, /requires "video"/],
      [{ video: SRC, start: "https://a.test/f.png" }, {}, /cannot be combined/],
      [{ start: "in/empty.png" }, {}, /Media file is empty/, sb],
      [{ start: "in/big.png" }, { limits: { maxInputBytes: 16 } }, /exceeds maximum/, sb],
      [{ start: "in/text.bin" }, {}, /unrecognized media/, sb],
      [{ video: "in/frame.png" }, {}, /Unsupported media type/, sb],
      [{ n: 3 }, { limits: { maxVideosPerCall: 2 } }, /maximum of 2 videos/],
      [{ duration: 12 }, { limits: { maxDurationSeconds: 8 } }, /maximum of 8s/],
      [
        { references: Array.from({ length: 17 }, (_, i) => `${C}/r${i}.png`) },
        {},
        /At most 16 reference items/,
      ],
      [
        { references: ["in/frame.png", "in/frame.png", "in/frame.png"] },
        { limits: { maxInputBytes: 25 } },
        /exceeds maximum allowed/,
        sb,
      ],
    ];
    eq(
      T.generateVideoInputSchema.safeParse({
        prompt: "p",
        references: Array.from({ length: 17 }, () => `${C}/a.png`),
      }).success,
      false,
    );
    for (const [inp, cfg, re, sandbox] of rows) {
      const f = mkAsync();
      extension({ model: f.model, storage, ...cfg });
      await failStep(() => sub({ prompt: "p", ...inp }, { sandbox }), re);
      eq(f.startCalls.length, 0);
    }

    for (const cap of [1, async () => 1] as const) {
      const staged = inMemory({ baseUrl: "https://cdn.test/m" });
      const f = mkAsync({ maxVideosPerCall: cap });
      extension({ model: f.model, storage: staged });
      const bigSb = mkSb({ "in/big.png": H.createLargePng() });
      await failStep(
        () => sub({ prompt: "Cap", n: 2, start: "in/big.png" }, { sandbox: bigSb }),
        /allows at most 1 video\(s\)/,
      );
      deq([f.startCalls.length, staged.keys()], [0, []]);
    }

    const badSchemes: Partial<Types.GenerateVideoToolInput>[] = [
      { video: "ftp://a.test/a.mp4" },
      { start: "file:///etc/passwd" },
      { references: ["data:image/png;base64,AA=="] },
    ];
    for (const inp of badSchemes) {
      let sbCalls = 0;
      const f = mkAsync();
      extension({ model: f.model, storage });
      const getSandbox = async () => (sbCalls++, mkSb());
      await failStep(() => sub({ prompt: "p", ...inp }, { getSandbox }), /Refusing non-HTTPS URL/);
      deq([sbCalls, f.startCalls.length], [0, 0]);
    }

    let chunksPulled = 0;
    const hugeStreamSandbox: H.FakeSandbox = {
      ...mkSb(),
      readFile: async () =>
        new ReadableStream<Uint8Array>({
          pull(c) {
            chunksPulled += 1;
            c.enqueue(new Uint8Array(64));
          },
        }),
    };
    const fStream = mkAsync();
    extension({ model: fStream.model, storage, limits: { maxInputBytes: 100 } });
    await failStep(
      () => sub({ prompt: "Huge", start: "in/huge.png" }, { sandbox: hugeStreamSandbox }),
      /exceeds maximum allowed input size/,
    );
    assert.ok(chunksPulled <= 3);
    eq(fStream.startCalls.length, 0);
  });
});

describe("video iteration routing across Grok, Seedance, and FLUX 3", () => {
  test("Grok edit/extend routes providerOptions.xai, stages local/storageKey MP4s, and blocks non-public storage", async () => {
    const storage = inMemory({ baseUrl: "https://cdn.test/grok" });
    const sandbox = mkSb({ "clips/local.mp4": H.MP4_BYTES });
    const f = mkAsync({ modelId: GROK, provider: "gateway" });
    const defaults = { duration: 6, aspectRatio: "16:9", resolution: "720p" };
    extension({ model: f.model, storage, defaults, providerOptions: xaiOpts({}) });

    await sub({ prompt: "Edit", video: SRC });
    const editIn = {
      prompt: "Edit2",
      video: SRC,
      mode: "edit" as const,
      duration: 8,
      aspectRatio: "9:16",
      resolution: "1080p",
    };
    await sub(editIn);
    for (const c of f.startCalls) {
      deq(
        [c.inputReferences, c.duration, c.aspectRatio, c.resolution],
        [undefined, undefined, undefined, undefined],
      );
      deq(c.providerOptions, xaiOpts({ videoUrl: SRC }));
    }

    await sub({ prompt: "Ext", video: SRC, mode: "extend", duration: 5 });
    const c2 = f.startCalls[2];
    deq([c2.duration, c2.aspectRatio, c2.resolution], [5, "16:9", "1280x720"]);
    deq(c2.providerOptions, xaiOpts({ videoUrl: SRC, mode: "extend-video" }));

    const fromSb = await sub({ prompt: "Sb", video: "clips/local.mp4" }, { sandbox });
    if (fromSb.kind !== "async") assert.fail();
    const k1 = fromSb.handle.stagedInputKeys![0];
    assert.match(k1, /^inputs\/.*\/video\.mp4$/);
    deq(f.startCalls[3].providerOptions, xaiOpts({ videoUrl: `https://cdn.test/grok/${k1}` }));

    await putFile(storage, "videos/prior.mp4");
    const fromKey = await sub({
      prompt: "Key",
      video: "videos/prior.mp4",
      mode: "extend",
      duration: 4,
    });
    if (fromKey.kind !== "async") assert.fail();
    const k2 = fromKey.handle.stagedInputKeys![0];
    deq(
      f.startCalls[4].providerOptions,
      xaiOpts({ videoUrl: `https://cdn.test/grok/${k2}`, mode: "extend-video" }),
    );

    const bads = [
      inMemory({ baseUrl: "https://cdn.test/p", visibility: "private" }),
      inMemory({ baseUrl: "http://cdn.test/h" }),
      inMemory(),
    ];
    for (const bad of bads) {
      const blocked = mkAsync({ modelId: GROK });
      extension({ model: blocked.model, storage: bad });
      await failStep(
        () => sub({ prompt: "Blocked", video: "clips/local.mp4" }, { sandbox }),
        /requires public HTTPS storage/,
      );
      deq([blocked.startCalls.length, bad.keys()], [0, []]);
    }
  });

  test("Seedance and FLUX 3 prepend video to inputReferences, omit extend aspectRatio, stage >180 KiB MP4s, and resolve storageKey", async () => {
    const storage = inMemory({ baseUrl: "https://cdn.test/m" });
    const seed = mkAsync({ modelId: "bytedance/seedance-2.5", provider: "gateway" });
    const defaults = { aspectRatio: "16:9", resolution: "720p", duration: 5 };
    extension({ model: seed.model, storage, defaults });

    await sub({ prompt: "Edit", video: SRC, mode: "edit", references: [`${C}/ref.png`] });
    deq(seed.startCalls[0].inputReferences, [
      ref(SRC, "video/mp4"),
      ref(`${C}/ref.png`, "image/png"),
    ]);
    eq(seed.startCalls[0].aspectRatio, "16:9");

    await sub({ prompt: "Ext", video: SRC, mode: "extend" });
    deq([seed.startCalls[1].aspectRatio, seed.startCalls[1].resolution], [undefined, "1280x720"]);

    const flux = mkAsync({ modelId: "bfl/flux-3-video", provider: "gateway" });
    extension({ model: flux.model, storage });
    await sub({ prompt: "NoExt", video: `${C}/no-ext`, mode: "extend" });
    deq(flux.startCalls[0].inputReferences, [ref(`${C}/no-ext`, "video/mp4")]);

    const bigSb = mkSb({ "clips/big.mp4": H.createLargeMp4() });
    const staged = await sub({ prompt: "Big", video: "clips/big.mp4" }, { sandbox: bigSb });
    if (staged.kind !== "async") assert.fail();
    const k = staged.handle.stagedInputKeys![0];
    deq(flux.startCalls[1].inputReferences, [ref(`https://cdn.test/m/${k}`, "video/mp4")]);

    await putFile(storage, "videos/stored.mp4");
    await sub({ prompt: "NoSb", video: "videos/stored.mp4" });
    await sub({ prompt: "EmptySb", video: "videos/stored.mp4" }, { sandbox: mkSb() });
    const inlineFile = [{ type: "file", data: H.MP4_BYTES, mediaType: "video/mp4" }];
    for (const i of [2, 3]) deq(flux.startCalls[i].inputReferences, inlineFile);

    await failStep(
      () => sub({ prompt: "Miss", video: "videos/missing.mp4" }),
      /not found in storage/,
    );
    eq(flux.startCalls.length, 4);

    const midPng = H.createSizedPng(120 * 1024);
    const gw = mkAsync({ modelId: "bytedance/seedance-2.5-flash", provider: "gateway" });
    extension({ model: gw.model, storage });
    const midRes = await sub(
      { prompt: "MidStart", start: "in/mid.png" },
      { sandbox: mkSb({ "in/mid.png": midPng }) },
    );
    if (midRes.kind !== "async") assert.fail();
    const mk = midRes.handle.stagedInputKeys![0];
    deq(gw.startCalls[0].image, { type: "url", url: `https://cdn.test/m/${mk}` });

    const directGoogle = mkAsync({
      modelId: "veo-3.1-fast-generate-001",
      provider: "google.video",
    });
    extension({ model: directGoogle.model, storage });
    const directRes = await sub(
      { prompt: "DirectGoogle", start: "in/big.png" },
      { sandbox: mkSb({ "in/big.png": H.createLargePng() }) },
    );
    if (directRes.kind !== "async") assert.fail();
    eq(directRes.handle.stagedInputKeys, undefined);
    eq((directGoogle.startCalls[0].image as { type: string }).type, "file");
  });
});

describe("persistence, staging cleanup, labels, and approval", () => {
  test("persists batches to storage + sandbox, rolls back on failure, completes sync models, and cleans staged inputs on failure", async () => {
    eq(createIdempotencyKey("s1", "c1"), createIdempotencyKey("s1", "c1"));
    assert.notEqual(createIdempotencyKey("s1", "c1"), createIdempotencyKey("s1", "c2"));
    const prog = { status: "generating" as const, model: "m", elapsedSeconds: 12, attempt: 2 };
    eq(T.formatGenerateProgressLabel(prog), "Generating video (12s)");
    const twoVids = [
      { mediaType: "video/mp4", bytes: 1 },
      { mediaType: "video/mp4", bytes: 1 },
    ];
    eq(
      T.formatGenerateCompleteLabel({ status: "completed", model: "m", videos: twoVids }),
      "Generated 2 videos",
    );

    const storage = inMemory({ baseUrl: "https://media.test/b" });
    const sandbox = mkSb();
    const batch = mkAsync({
      modelId: "test/batch",
      statuses: [
        {
          status: "completed",
          videos: [
            { type: "binary", data: H.MP4_BYTES, mediaType: "video/mp4" },
            { type: "binary", data: H.WEBM_BYTES, mediaType: "video/webm" },
          ],
          warnings: [
            { type: "other", message: "Start warn" },
            { type: "unsupported", feature: "fps", details: "fixed at 24" },
          ],
        },
      ],
    });
    extension({ model: batch.model, storage });
    const inp = { prompt: "Batch", path: "v/clip.mp4" };
    const res = await sub(inp, { sandbox, sessionId: "s-i", callId: "c-i" });
    if (res.kind !== "async") assert.fail();
    const idem = (batch.startCalls[0].headers as Record<string, string>)["idempotency-key"];
    eq(idem, createIdempotencyKey("s-i", "c-i"));

    const h = { ...res.handle, warnings: ["Start warn"] };
    const chk = await S.checkAndPersistStep(inp, mkCtx({ sandbox }), h);
    if (chk.status !== "completed") assert.fail();
    deq(
      chk.output.videos.map((v) => v.path),
      ["v/clip.mp4", "v/clip-1.mp4"],
    );
    deq(sandbox.files.get("v/clip.mp4"), H.MP4_BYTES);
    deq(sandbox.files.get("v/clip-1.mp4"), H.WEBM_BYTES);
    deq(chk.output.warnings, ["Start warn", "Unsupported fps: fixed at 24"]);

    const backing = inMemory();
    const deleted: string[] = [];
    let puts = 0;
    const flaky: VideoStorage = {
      put: async (i) =>
        ++puts === 2 ? Promise.reject(new Error("quota exceeded")) : backing.put(i),
      get: (i) => backing.get(i),
      delete: async (i) => (deleted.push(i.key), backing.delete(i)),
    };
    extension({ model: batch.model, storage: flaky });
    await failStep(
      () => S.checkAndPersistStep({ prompt: "RB" }, mkCtx(), res.handle),
      /quota exceeded/,
    );
    deq([deleted.length, backing.keys()], [1, []]);

    const syncStorage = inMemory({ baseUrl: "https://media.test/sync" });
    extension({ model: mkSync({ modelId: "test/sync" }).model, storage: syncStorage });
    const syncRes = await sub({ prompt: "Sync" });
    if (syncRes.kind !== "completed") assert.fail();
    const syncKey = syncRes.output.videos[0].storageKey!;
    deq((await syncStorage.get({ key: syncKey, signal: SIG }))?.data, H.MP4_BYTES);

    const failStage = inMemory({ baseUrl: "https://media.test/clean" });
    const badSync = mkSync({
      modelId: GROK,
      onGenerate: () => Promise.reject(new Error("sync failure")),
    });
    extension({ model: badSync.model, storage: failStage });
    const clipSb = mkSb({ "clips/a.mp4": H.MP4_BYTES });
    await failStep(
      () => sub({ prompt: "Fail", video: "clips/a.mp4" }, { sandbox: clipSb }),
      /sync failure/,
    );
    deq(failStage.keys(), []);
  });

  test("createGenerateApproval handles unset, always(), Generate/Edit/Extend prompts, and custom ApprovalConfiguration", async () => {
    const input: Types.GenerateVideoToolInput = {
      prompt: "Lighthouse",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1080p",
      audio: true,
      n: 2,
      path: "v/lh.mp4",
    };
    let cfg: Types.VideoExtensionConfig = { model: "bytedance/seedance-2.5-flash" };
    const approval = T.createGenerateApproval(() => cfg);
    const promptFor = (inp: Types.GenerateVideoToolInput) =>
      approval.prompt?.({ callId: "c1", input: inp, toolName: "video__generate" }) ?? "";

    deq(
      [await approval.request(H.createFakeApprovalContext(input)), approval.response],
      ["not-applicable", undefined],
    );
    cfg = { ...cfg, approval: always() };
    deq(
      [await approval.request(H.createFakeApprovalContext(input)), approval.response],
      ["user-approval", undefined],
    );
    eq(
      promptFor(input),
      'Generate video with bytedance/seedance-2.5-flash (6s, 16:9, 1080p, audio, 2 videos, path: v/lh.mp4): "Lighthouse"',
    );
    assert.match(
      promptFor({ prompt: "Twilight", video: "v/a.mp4" }),
      /^Edit video with .* \(video: v\/a\.mp4\): "Twilight"$/,
    );
    assert.match(
      promptFor({ prompt: "More", video: SRC, mode: "extend", duration: 5 }),
      /^Extend video with .* \(video: https:\/\/cdn\.example\.com\/clip\.mp4, 5s\): "More"$/,
    );

    const custom: ApprovalConfiguration<Types.GenerateVideoToolInput> = {
      request: () => "user-approval",
      prompt: (c) => `Custom: ${c.input.prompt}`,
      response: () => ({ status: "allowed" }),
    };
    cfg = { ...cfg, approval: custom };
    deq([promptFor(input), approval.response], ["Custom: Lighthouse", custom.response]);
  });
});

describe("workflow steps and runVideoWorkflowTask state machine", () => {
  test("verifyAndRespondWebhookStep, step error classification (including download 503), webhook mode, and cleanupStagedInputsStep", async () => {
    const [sec, body, now] = [
      "whsec_step",
      '{"event":"video.completed"}',
      Math.floor(Date.now() / 1000),
    ];
    const validSig = signHdr(sec, body, now);
    const runWh = async (
      b: string | ReadableStream<Uint8Array>,
      hdr?: Record<string, string>,
      err?: Error,
    ) => {
      const r = fakeReq(b, hdr, err);
      return [await S.verifyAndRespondWebhookStep(r.req, sec), r.responses[0].status] as const;
    };

    deq(await runWh(body, { "x-ai-gateway-signature": validSig }), [true, 204]);
    let [reads, cancelled] = [0, false];
    const missStream = new ReadableStream({
      pull: (c) => (reads++, c.enqueue(new TextEncoder().encode(body)), c.close()),
      cancel: () => void (cancelled = true),
    });
    deq([...(await runWh(missStream)), reads, cancelled], [false, 401, 0, true]);
    deq(await runWh(body, { "x-ai-gateway-signature": signHdr("wrong", body, now) }), [false, 401]);

    let bigChunks = 0;
    const overStream = new ReadableStream({
      pull: (c) => void (c.enqueue(new Uint8Array(20 * 1024)), ++bigChunks >= 10 && c.close()),
    });
    deq(await runWh(overStream, { "x-ai-gateway-signature": validSig }), [false, 413]);
    assert.ok(bigChunks <= 4);
    deq(await runWh(body, { "x-ai-gateway-signature": validSig }, new Error("closed")), [
      true,
      204,
    ]);

    const storage = inMemory();
    const retryables = [
      H.createHttpError(503, "503 down"),
      H.createHttpError(429, "429 limit"),
      Object.assign(new Error("conn reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("AI retry exhausted"), {
        lastError: H.createHttpError(503, "upstream 503"),
      }),
      new DOMException("Timed out", "TimeoutError"),
    ];
    for (const err of retryables) {
      extension({ model: mkAsync({ onStart: () => Promise.reject(err) }).model, storage });
      await failStep(() => sub({ prompt: "Retry" }), new RegExp(err.message), false);
    }

    const dl503 = await downloadVideoBytes("https://93.184.216.34/c.mp4", {
      maxBytes: 1024,
      signal: SIG,
      fetch: async () => new Response("down", { status: 503 }),
    }).catch((e: unknown) => e);
    eq(isTransientProviderError(dl503), true);

    const stModel = mkAsync({
      modelId: "test/st",
      statuses: [
        { status: "error", error: "Safety rejected" },
        () => Promise.reject(H.createHttpError(400, "Unknown op")),
        () => Promise.reject(dl503),
      ],
      repeatLastStatus: false,
    });
    extension({ model: stModel.model, storage });
    const jh: Types.VideoJobHandle = { modelId: "test/st", operation: { id: "op" }, warnings: [] };
    const cp = () => S.checkAndPersistStep({ prompt: "x" }, mkCtx(), jh);
    await failStep(cp, /Safety rejected/, true);
    await failStep(cp, /Unknown op/, true);
    await failStep(cp, /HTTP 503/, false);

    const whModel = mkAsync({
      handleWebhookOption: true,
      jobId: "j1",
      webhookSigningSecret: "whsec_live",
    });
    extension({ model: whModel.model, storage, webhook: "auto" });
    const whRes = await sub({ prompt: "WH" }, undefined, WH_URL);
    eq(whRes.kind === "async" && whRes.useWebhook, true);
    extension({ model: whModel.model, storage, webhook: "never" });
    const noWh = await sub({ prompt: "NoWH" }, undefined, WH_URL);
    eq(noWh.kind === "async" && noWh.useWebhook, false);

    await putFile(storage, "inputs/s1.png", H.PNG_BYTES, "image/png");
    await putFile(storage, "videos/keep.mp4");
    await S.cleanupStagedInputsStep(["inputs/s1.png"]);
    deq(storage.keys(), ["videos/keep.mp4"]);
  });

  test("runVideoWorkflowTask covers all 8 webhook, fallback, local polling, sync, timeout, abort, and cleanup scenarios", async () => {
    const h1 = createHarness({ staged: ["inputs/a.png"] });
    const p1 = runTask(h1.deps);
    await h1.waitSleep(1);
    deq(h1.events, ["createWebhook", "getConflict:start", "getConflict:done", "submit"]);
    deq(h1.sleeps, [R.WEBHOOK_FALLBACK_POLL_MS]);
    h1.push({ id: "ok", valid: true });
    deq([(await p1).progress.length, h1.disposed(), h1.cleaned], [1, 1, [["inputs/a.png"]]]);

    const h2 = createHarness();
    const p2 = runTask(h2.deps);
    await h2.waitSleep(1);
    h2.push({ id: "bad", valid: false });
    await h2.waitRead(2);
    deq([h2.checks(), h2.sleeps], [0, [R.WEBHOOK_FALLBACK_POLL_MS]]);
    h2.push({ id: "ok", valid: true });
    const r2 = await p2;
    deq([r2.progress.length, r2.progress[0].attempt], [1, 1]);

    const hSpam = createHarness();
    const pSpam = runTask(hSpam.deps);
    await hSpam.waitSleep(1);
    for (let i = 0; i < R.MAX_INVALID_WEBHOOK_DELIVERIES; i += 1)
      hSpam.push({ id: `f${i}`, valid: false });
    await hSpam.waitSleep(2);
    deq([hSpam.disposed(), hSpam.sleeps], [1, [R.WEBHOOK_FALLBACK_POLL_MS, 5_000]]);
    hSpam.wakeSleep(1);
    eq((await pSpam).output.jobId, "j1");

    const checkEv = async (i: number) =>
      i === 0 ? pendingRes(["Replicating"]) : doneRes("j1", ["Done"]);
    const hEv = createHarness({ staged: ["inputs/ev.png"], check: checkEv });
    const pEv = runTask(hEv.deps);
    await hEv.waitSleep(1);
    hEv.push({ id: "early", valid: true });
    await hEv.waitSleep(2);
    eq(hEv.disposed(), 1);
    hEv.wakeSleep(1);
    deq((await pEv).output.warnings, ["Done", "Replicating"]);

    const checkFb = async (i: number) => (i === 0 ? pendingRes(["Queued"]) : doneRes());
    const hFb = createHarness({ staged: ["inputs/fb.png"], timeoutMs: 300_000, check: checkFb });
    const pFb = runTask(hFb.deps);
    await hFb.waitSleep(1);
    hFb.wakeSleep(0);
    await hFb.waitSleep(2);
    hFb.wakeSleep(1);
    deq([(await pFb).progress[1].elapsedSeconds, hFb.disposed()], [60, 1]);

    const localOpts = { metadataUrl: "http://127.0.0.1:3000", useWebhook: false, autoSleep: true };
    const local = createHarness({
      ...localOpts,
      staged: ["inputs/l.png"],
      check: async (i) => (i < 2 ? pendingRes(["Rendering"]) : doneRes()),
    });
    deq((await runTask(local.deps)).output.warnings, ["Rendering"]);
    deq([local.whCalls(), local.sleeps], [0, [5_000, 5_000, 5_000]]);

    const syncH = createHarness({ submitResult: { kind: "completed", output: outOf("j_sync") } });
    deq([(await runTask(syncH.deps)).progress, syncH.disposed(), syncH.checks()], [[], 1, 0]);

    const edge = createHarness({
      ...localOpts,
      staged: ["inputs/t.png"],
      intervalMs: 10_000,
      timeoutMs: 4_000,
      check: async () => pendingRes(),
    });
    await failStep(() => runTask(edge.deps), /timed out after 4000ms/);
    assert.ok(edge.checks() >= 1);
    deq(edge.cleaned, [["inputs/t.png"]]);

    const ac = new AbortController();
    const abH = createHarness({ staged: ["inputs/ab.png"], check: async () => pendingRes() });
    const abP = runTask(abH.deps, mkCtx({ signal: ac.signal }));
    await abH.waitSleep(1);
    ac.abort(new Error("user cancelled"));
    await assert.rejects(() => abP, /user cancelled/);
    deq([abH.disposed(), abH.cleaned], [1, [["inputs/ab.png"]]]);

    const subErr = createHarness({ submitError: new FatalError("submit failed") });
    await failStep(() => runTask(subErr.deps), /submit failed/);
    deq([subErr.disposed(), subErr.cleaned], [1, []]);

    const chkErr = createHarness({
      staged: ["inputs/ce.png"],
      check: () => Promise.reject(new FatalError("provider rejected")),
    });
    const chkP = runTask(chkErr.deps);
    await chkErr.waitSleep(1);
    chkErr.push({ id: "d1", valid: true });
    await failStep(() => chkP, /provider rejected/);
    deq([chkErr.disposed(), chkErr.cleaned], [1, [["inputs/ce.png"]]]);
  });
});
