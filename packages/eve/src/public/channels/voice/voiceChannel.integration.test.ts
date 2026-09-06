import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#internal/voice/gateway-voice-models.js", () => ({
  transcriptionModel: () => ({ id: "stt" }),
  speechModel: () => ({ id: "tts" }),
}));
vi.mock("#internal/voice/transcribe.js", () => ({ transcribeAudio: vi.fn() }));
vi.mock("#internal/voice/synthesize.js", () => ({ synthesizeSpeech: vi.fn() }));

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { none } from "#public/channels/auth.js";
import type {
  SendFn,
  Session,
  WebSocketMessage,
  WebSocketPeer,
} from "#public/definitions/defineChannel.js";
import { transcribeAudio } from "#internal/voice/transcribe.js";
import { synthesizeSpeech } from "#internal/voice/synthesize.js";
import { createVoiceConnection } from "#public/channels/voice/voiceChannel.js";

const transcribeMock = vi.mocked(transcribeAudio);
const synthesizeMock = vi.mocked(synthesizeSpeech);

function eventStream(events: HandleMessageStreamEvent[]): ReadableStream<HandleMessageStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

/** A minimal in-memory peer that records the frames the channel sends. */
function createFakePeer(): WebSocketPeer & {
  readonly textFrames: Array<Record<string, unknown>>;
  readonly binaryFrames: Uint8Array[];
} {
  const textFrames: Array<Record<string, unknown>> = [];
  const binaryFrames: Uint8Array[] = [];
  return {
    id: "peer-1",
    context: {},
    namespace: "",
    request: new Request("https://agent.test/eve/v1/voice"),
    topics: new Set<string>(),
    close() {},
    publish() {},
    subscribe() {},
    unsubscribe() {},
    terminate() {},
    send(data: unknown) {
      if (typeof data === "string") {
        textFrames.push(JSON.parse(data));
      } else {
        binaryFrames.push(data as Uint8Array);
      }
    },
    textFrames,
    binaryFrames,
  };
}

function binaryMessage(bytes: Uint8Array): WebSocketMessage {
  return {
    id: "m1",
    data: bytes,
    rawData: bytes,
    uint8Array: () => bytes,
    arrayBuffer: () => bytes.buffer as ArrayBuffer,
    blob: () => new Blob([]),
    json: () => {
      throw new Error("json() is not used for binary frames");
    },
    text: () => "",
  };
}

function textMessage(text: string): WebSocketMessage {
  return {
    id: "m1",
    data: text,
    rawData: text,
    uint8Array: () => new TextEncoder().encode(text),
    arrayBuffer: () => new ArrayBuffer(0),
    blob: () => new Blob([text]),
    json: () => JSON.parse(text),
    text: () => text,
  };
}

const REPLY_EVENTS: HandleMessageStreamEvent[] = [
  { type: "turn.started", data: { turnId: "t1", sequence: 0 } },
  {
    type: "message.appended",
    data: {
      messageDelta: "Hi there. ",
      messageSoFar: "Hi there. ",
      sequence: 1,
      stepIndex: 0,
      turnId: "t1",
    },
  },
  {
    type: "message.completed",
    data: {
      message: "Hi there.",
      finishReason: "stop",
      sequence: 2,
      stepIndex: 0,
      turnId: "t1",
    },
  },
  { type: "turn.completed", data: { turnId: "t1", sequence: 3 } },
];

function connect() {
  const audioOut = new Uint8Array([1, 2, 3]);
  synthesizeMock.mockResolvedValue({ audio: audioOut, format: "mp3" });

  const getEventStream = vi.fn(async () => eventStream(REPLY_EVENTS));
  const send = vi.fn<SendFn>(
    async (_input, options): Promise<Session> => ({
      id: "session-1",
      continuationToken: options.continuationToken,
      getEventStream,
    }),
  );

  const hooks = createVoiceConnection({
    config: { auth: [none()] },
    send,
    sttModelId: "openai/whisper-1",
    ttsModelId: "openai/tts-1",
    voice: "alloy",
    outputFormat: "mp3",
  });

  return { hooks, send, audioOut };
}

async function authorize(hooks: ReturnType<typeof connect>["hooks"]): Promise<void> {
  const result = await hooks.upgrade?.(new Request("https://agent.test/eve/v1/voice"));
  expect(result).not.toBeInstanceOf(Response);
}

describe("voiceChannel connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transcribes an utterance, runs a turn, and speaks the reply", async () => {
    transcribeMock.mockResolvedValue({ text: "hello", language: "en", durationInSeconds: 1 });
    const { hooks, send, audioOut } = connect();
    const peer = createFakePeer();
    await authorize(hooks);

    hooks.message?.(peer, binaryMessage(new Uint8Array([9, 9])));

    await vi.waitFor(() => {
      expect(peer.textFrames.some((f) => f.type === "status" && f.state === "idle")).toBe(true);
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [input, options] = send.mock.calls[0] ?? [];
    expect(input).toBe("hello");
    expect(options).toMatchObject({ mode: "conversation" });
    expect(options?.continuationToken).toBeTruthy();

    expect(peer.textFrames).toContainEqual({ type: "user_transcript", text: "hello" });
    expect(peer.textFrames).toContainEqual({ type: "assistant_text", text: "Hi there." });
    expect(peer.textFrames).toContainEqual({ type: "status", state: "thinking" });
    expect(peer.textFrames).toContainEqual({ type: "status", state: "speaking" });
    expect(peer.binaryFrames).toEqual([audioOut]);
  });

  it("does not start a turn when the transcript is empty", async () => {
    transcribeMock.mockResolvedValue({ text: "   ", language: undefined, durationInSeconds: 0 });
    const { hooks, send } = connect();
    const peer = createFakePeer();
    await authorize(hooks);

    hooks.message?.(peer, binaryMessage(new Uint8Array([0])));

    await vi.waitFor(() => {
      expect(peer.textFrames.some((f) => f.type === "status" && f.state === "idle")).toBe(true);
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("runs a turn from a text control frame without transcribing", async () => {
    const { hooks, send } = connect();
    const peer = createFakePeer();
    await authorize(hooks);

    hooks.message?.(peer, textMessage(JSON.stringify({ type: "text", text: "typed hello" })));

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(transcribeMock).not.toHaveBeenCalled();
    const [input] = send.mock.calls[0] ?? [];
    expect(input).toBe("typed hello");
  });

  it("rejects the upgrade when auth fails", async () => {
    // An empty auth walk rejects with a 401 before any session starts.
    const failingSend: SendFn = async () => {
      throw new Error("should not send");
    };
    const rejecting = createVoiceConnection({
      config: { auth: [] },
      send: failingSend,
      sttModelId: "openai/whisper-1",
      ttsModelId: "openai/tts-1",
      voice: "alloy",
      outputFormat: "mp3",
    });

    const result = await rejecting.upgrade?.(new Request("https://agent.test/eve/v1/voice"));
    expect(result).toBeInstanceOf(Response);
    expect(result instanceof Response ? result.status : 0).toBe(401);
  });
});
