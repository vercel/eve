"use client";

/**
 * The desktop's live view: a client for screen-relay's `/stream` WebSocket, which the page opens
 * with a ticket from the /api/live route. Frames arrive as H.264 and are decoded with WebCodecs;
 * the desktop's cursor image arrives beside them; Take Over input goes back as screen-relay input
 * records. See https://github.com/vercel-labs/screen-relay/blob/main/PROTOCOL.md.
 */

const HEADER_BYTES = 20;
const RECORD_BYTES = 16;
const MAGIC = 0x4e534c31; // "NSL1"
const VERSION = 1;
const KEYFRAME = 1;
/** Coordinates in input records run from 0 to this across the desktop. */
const COORDINATE_MAX = 65535;

const MESSAGE = { frame: 1, ack: 2, input: 3, cursor: 6 } as const;
/** A cursor message's width, height, and hotspot, before its pixels. */
const CURSOR_HEADER_BYTES = 8;
const INPUT = {
  keyDown: 1,
  keyUp: 2,
  pointerMove: 3,
  buttonDown: 4,
  buttonUp: 5,
  wheel: 6,
  text: 8,
} as const;

const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };

/** Browser wheel pixels per notch, and screen-relay's wheel units per notch. */
const WHEEL_PIXELS = 100;
const WHEEL_NOTCH = 120;
const WHEEL_MAX = 1200;

interface Size {
  readonly width: number;
  readonly height: number;
}

interface PendingFrame {
  readonly generation: number;
  readonly sequence: number;
  readonly arrived: number;
}

/** Whether this browser can decode the desktop's H.264 stream. */
export function canDecodeDesktop(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/**
 * One `/stream` connection: decodes its frames onto `canvas`, acknowledges each one so the engine
 * keeps sending, and turns the live view's input messages into input records.
 */
export class DesktopStream {
  private generation = 0;
  private size: Size | null = null;
  private codec: string | null = null;
  private decoder: VideoDecoder | null = null;
  private pending: PendingFrame[] = [];
  /** Keys whose press was sent as text, so their release is not sent as a key. */
  private typed = new Set<string>();
  private wheel = { vertical: 0, horizontal: 0 };

  constructor(
    private readonly socket: WebSocket,
    private readonly canvas: () => HTMLCanvasElement | null,
    private readonly onFrame: (size: Size) => void,
    /** The desktop's cursor as a CSS `cursor` value, or null for the page's own arrow. */
    private readonly onCursor: (cursor: string | null) => void,
  ) {
    socket.binaryType = "arraybuffer";
  }

  receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES) return;
    const view = new DataView(data);
    if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== VERSION) return;
    if (view.getUint32(16) !== data.byteLength - HEADER_BYTES) return;
    if (view.getUint8(5) === MESSAGE.cursor) return this.cursor(view);
    if (view.getUint8(5) !== MESSAGE.frame || data.byteLength < HEADER_BYTES + 12) return;

    const generation = view.getUint32(8);
    const sequence = view.getUint32(12);
    const keyframe = (view.getUint16(6) & KEYFRAME) !== 0;
    const size = { width: view.getUint16(HEADER_BYTES), height: view.getUint16(HEADER_BYTES + 2) };
    const captured = Number(view.getBigUint64(HEADER_BYTES + 4));
    const unit = new Uint8Array(data, HEADER_BYTES + 12);
    this.generation = generation;
    this.size = size;
    const arrived = performance.now();

    if (keyframe) this.configure(unit, size);
    const decoder = this.decoder;
    if (decoder === null || decoder.state !== "configured") {
      this.ack({ generation, sequence, arrived });
      return;
    }
    this.pending.push({ generation, sequence, arrived });
    decoder.decode(
      new EncodedVideoChunk({ type: keyframe ? "key" : "delta", timestamp: captured, data: unit }),
    );
  }

  /** A live view input message, in the shape agent-browser's stream takes; see live-view.tsx. */
  send(message: Record<string, unknown>): void {
    if (this.generation === 0 || this.size === null) return;
    for (const record of this.records(message)) {
      const buffer = new ArrayBuffer(HEADER_BYTES + RECORD_BYTES);
      this.header(new DataView(buffer), MESSAGE.input, 0, RECORD_BYTES);
      new Uint8Array(buffer, HEADER_BYTES).set(new Uint8Array(record));
      this.write(buffer);
    }
  }

  close(): void {
    if (this.decoder !== null && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.pending = [];
  }

  /** Width, height, and hotspot, then straight-alpha RGBA rows; all zero restores the arrow. */
  private cursor(view: DataView): void {
    if (view.byteLength < HEADER_BYTES + CURSOR_HEADER_BYTES) return;
    const width = view.getUint16(HEADER_BYTES);
    const height = view.getUint16(HEADER_BYTES + 2);
    if (width === 0 || height === 0) return this.onCursor(null);
    const pixels = Uint8ClampedArray.from(
      new Uint8Array(
        view.buffer,
        HEADER_BYTES + CURSOR_HEADER_BYTES,
        view.byteLength - HEADER_BYTES - CURSOR_HEADER_BYTES,
      ),
    );
    if (pixels.length !== width * height * 4) return;
    const image = document.createElement("canvas");
    image.width = width;
    image.height = height;
    image.getContext("2d")?.putImageData(new ImageData(pixels, width, height), 0, 0);
    const x = view.getUint16(HEADER_BYTES + 4);
    const y = view.getUint16(HEADER_BYTES + 6);
    this.onCursor(`url(${image.toDataURL()}) ${x} ${y}, auto`);
  }

  private configure(unit: Uint8Array, size: Size): void {
    const codec = avcCodec(unit);
    if (codec === null) return;
    if (
      this.decoder !== null &&
      this.decoder.state === "configured" &&
      codec === this.codec &&
      size.width === this.size?.width &&
      size.height === this.size.height
    )
      return;
    this.decoder ??= new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => this.socket.close(),
    });
    // Frames still decoding under the old configuration are dropped; acknowledge them now.
    for (const frame of this.pending.splice(0)) this.ack(frame);
    this.decoder.reset();
    this.decoder.configure({
      codec,
      codedWidth: size.width,
      codedHeight: size.height,
      optimizeForLatency: true,
    });
    this.codec = codec;
  }

  private draw(frame: VideoFrame): void {
    const canvas = this.canvas();
    if (canvas !== null) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      canvas.getContext("2d")?.drawImage(frame, 0, 0);
      this.onFrame({ width: frame.displayWidth, height: frame.displayHeight });
    }
    frame.close();
    const pending = this.pending.shift();
    if (pending !== undefined) this.ack(pending);
  }

  private ack({ generation, sequence, arrived }: PendingFrame): void {
    const buffer = new ArrayBuffer(HEADER_BYTES + 4);
    const view = new DataView(buffer);
    this.header(view, MESSAGE.ack, sequence, 4, generation);
    const waited = Math.round((performance.now() - arrived) * 1000);
    view.setUint32(HEADER_BYTES, Math.min(Math.max(waited, 0), 0xffffffff));
    this.write(buffer);
  }

  private header(
    view: DataView,
    type: number,
    sequence: number,
    length: number,
    generation = this.generation,
  ): void {
    view.setUint32(0, MAGIC);
    view.setUint8(4, VERSION);
    view.setUint8(5, type);
    view.setUint16(6, 0);
    view.setUint32(8, generation);
    view.setUint32(12, sequence);
    view.setUint32(16, length);
  }

  private write(buffer: ArrayBuffer): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(buffer);
  }

  private records(message: Record<string, unknown>): ArrayBuffer[] {
    if (message.type === "input_mouse") return this.mouse(message);
    if (message.type === "input_keyboard") return this.keyboard(message);
    return [];
  }

  private mouse(message: Record<string, unknown>): ArrayBuffer[] {
    const size = this.size!;
    const x = coordinate(Number(message.x), size.width);
    const y = coordinate(Number(message.y), size.height);
    const button = BUTTONS[String(message.button)] ?? 1;
    switch (message.eventType) {
      case "mouseMoved":
        return [record(INPUT.pointerMove, { x, y })];
      case "mousePressed":
        return [record(INPUT.buttonDown, { code: button, x, y })];
      case "mouseReleased":
        return [record(INPUT.buttonUp, { code: button, x, y })];
      case "mouseWheel":
        return [
          ...this.scroll("vertical", Number(message.deltaY) || 0, x, y),
          ...this.scroll("horizontal", Number(message.deltaX) || 0, x, y),
        ];
      default:
        return [];
    }
  }

  /** Browser wheel pixels, gathered into whole notches so a trackpad's small deltas still scroll. */
  private scroll(axis: "vertical" | "horizontal", delta: number, x: number, y: number) {
    this.wheel[axis] += delta;
    const notches = Math.trunc(this.wheel[axis] / WHEEL_PIXELS);
    if (notches === 0) return [];
    this.wheel[axis] -= notches * WHEEL_PIXELS;
    const value = Math.min(Math.max(notches * WHEEL_NOTCH, -WHEEL_MAX), WHEEL_MAX);
    return [record(INPUT.wheel, { code: axis === "vertical" ? 0 : 1, value, x, y })];
  }

  private keyboard(message: Record<string, unknown>): ArrayBuffer[] {
    const code = typeof message.code === "string" ? message.code : undefined;
    const text = typeof message.text === "string" ? message.text : undefined;
    if (message.eventType === "keyDown" && text !== undefined && text !== "\r") {
      if (code !== undefined) this.typed.add(code);
      return [...text].map((character) => record(INPUT.text, { value: character.codePointAt(0)! }));
    }
    if (code === undefined) return [];
    if (message.eventType === "keyUp" && this.typed.delete(code)) return [];
    const usage = HID_USAGE[code];
    if (usage === undefined) return [];
    return [record(message.eventType === "keyUp" ? INPUT.keyUp : INPUT.keyDown, { code: usage })];
  }
}

function coordinate(value: number, extent: number): number {
  if (!Number.isFinite(value) || extent <= 0) return 0;
  return Math.round(Math.min(Math.max(value / extent, 0), 1) * COORDINATE_MAX);
}

function record(
  type: number,
  fields: { code?: number; value?: number; x?: number; y?: number },
): ArrayBuffer {
  const buffer = new ArrayBuffer(RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setUint16(2, fields.code ?? 0);
  view.setInt32(4, fields.value ?? 0);
  view.setUint16(8, fields.x ?? 0);
  view.setUint16(10, fields.y ?? 0);
  return buffer;
}

/** The `avc1.PPCCLL` codec string from the SPS in an Annex B access unit, or null without one. */
function avcCodec(unit: Uint8Array): string | null {
  for (let index = 0; index + 4 < unit.length; index++) {
    if (unit[index] !== 0 || unit[index + 1] !== 0 || unit[index + 2] !== 1) continue;
    const nal = index + 3;
    if ((unit[nal]! & 0x1f) !== 7 || nal + 3 >= unit.length) continue;
    const hex = (byte: number) => byte.toString(16).padStart(2, "0");
    return `avc1.${hex(unit[nal + 1]!)}${hex(unit[nal + 2]!)}${hex(unit[nal + 3]!)}`;
  }
  return null;
}

/** USB HID keyboard usages by `KeyboardEvent.code`; screen-relay keys are physical. */
const HID_USAGE: Record<string, number> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [`Key${String.fromCharCode(65 + index)}`, 4 + index]),
  ),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`Digit${index + 1}`, 30 + index])),
  Digit0: 39,
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, 58 + index])),
  PrintScreen: 70,
  ScrollLock: 71,
  Pause: 72,
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  NumLock: 83,
  NumpadDivide: 84,
  NumpadMultiply: 85,
  NumpadSubtract: 86,
  NumpadAdd: 87,
  NumpadEnter: 88,
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`Numpad${index + 1}`, 89 + index]),
  ),
  Numpad0: 98,
  NumpadDecimal: 99,
  IntlBackslash: 100,
  ContextMenu: 101,
  NumpadEqual: 103,
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  MetaLeft: 227,
  ControlRight: 228,
  ShiftRight: 229,
  AltRight: 230,
  MetaRight: 231,
};
