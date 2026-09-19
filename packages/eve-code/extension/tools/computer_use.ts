import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import {
  computerUseDesktopSizeCommand,
  computerUseDriverCommand,
  computerUseDriverRequest,
  computerUseFocusCommand,
  computerUseLaunchCommand,
  computerUsePaths,
  computerUseWindowLayoutCommand,
  recordingPath,
  screenshotPath,
} from "../lib/computer-use.ts";

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;
const coordinate = z.number().int().min(0);
const screenshotFileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/u);
const recordingFileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/u);
const key = z.string().regex(/^[A-Za-z0-9_.-]+$/u);
const browserUrl = z
  .string()
  .url()
  .refine(isHttpUrl, { message: "browser URL must use HTTP or HTTPS" });
const button = z.enum(["left", "middle", "wheel", "right", "back", "forward"]).default("left");
const modifierKeys = z.array(key).min(1).max(4).optional();
function typeActionShape(maxLength: number) {
  return {
    action: z.literal("type"),
    text: z.string().min(1).max(maxLength),
    typingDelayMs: z.number().int().min(0).max(200).optional(),
    typingStyle: z.literal("natural").optional(),
  };
}
const typingStyleRefinement = [
  (value: { typingDelayMs?: number; typingStyle?: "natural" }) =>
    value.typingDelayMs === undefined || value.typingStyle === undefined,
  { message: "type action cannot set both typingDelayMs and typingStyle" },
] as const;
const sequenceTypeActionSchema = z.object(typeActionShape(2_000)).refine(...typingStyleRefinement);
const typeActionSchema = z.object(typeActionShape(10_000)).refine(...typingStyleRefinement);
const movementStyle = z.enum(["natural", "precision"]).optional();
const pointerDurationMs = z
  .number()
  .int()
  .min(0)
  .max(2000)
  .optional()
  .describe("optional cursor travel duration for recorded demos; use about 600ms");
const precisionMovementStyle = z.literal("precision").optional();
// Object-only coordinates keep the generated JSON Schema portable.
const dragPoint = z.object({
  x: coordinate.max(SCREEN_WIDTH - 1),
  y: coordinate.max(SCREEN_HEIGHT - 1),
});
const windowSelectorSchema = z.discriminatedUnion("app", [
  z.object({ app: z.literal("firefox") }),
  z.object({ app: z.literal("xterm"), instance: z.enum(["primary", "secondary"]) }),
]);
const windowRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
    message: "window region must fit within the desktop",
  });
const arrangeWindowsSchema = z.object({
  action: z.literal("arrange_windows"),
  windows: z
    .array(z.object({ selector: windowSelectorSchema, region: windowRegionSchema }))
    .min(1)
    .max(4),
  waitForMs: z.number().int().min(0).max(10_000).optional().default(5_000),
});
const sequenceActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    x: coordinate.max(SCREEN_WIDTH - 1),
    y: coordinate.max(SCREEN_HEIGHT - 1),
    button,
    durationMs: pointerDurationMs,
    movementStyle,
  }),
  z.object({
    action: z.literal("double_click"),
    x: coordinate.max(SCREEN_WIDTH - 1),
    y: coordinate.max(SCREEN_HEIGHT - 1),
    button,
    durationMs: pointerDurationMs,
    movementStyle,
  }),
  z.object({
    action: z.literal("triple_click"),
    x: coordinate.max(SCREEN_WIDTH - 1),
    y: coordinate.max(SCREEN_HEIGHT - 1),
    button,
    durationMs: pointerDurationMs,
    movementStyle,
  }),
  z.object({
    action: z.literal("drag"),
    path: z.array(dragPoint).min(2).max(100),
    movementStyle: precisionMovementStyle,
    durationMs: pointerDurationMs,
  }),
  z.object({ action: z.literal("keypress"), keys: z.array(key).min(1).max(4) }),
  z.object({
    action: z.literal("move"),
    x: coordinate.max(SCREEN_WIDTH - 1),
    y: coordinate.max(SCREEN_HEIGHT - 1),
    durationMs: pointerDurationMs,
    movementStyle,
  }),
  sequenceTypeActionSchema,
  z.object({ action: z.literal("wait"), durationMs: z.number().int().min(100).max(10_000) }),
  arrangeWindowsSchema,
  z.object({ action: z.literal("record_start"), path: recordingFileName }),
  z.object({ action: z.literal("record_stop") }),
]);

const driverResponseSchema = z
  .object({
    backend: z.literal("cua-driver"),
    screenshot: z.string(),
    state: z.string(),
    action: z.unknown().optional(),
    version: z.literal("0.12.5"),
  })
  .passthrough();

const inputSchema = z.union([
  z.union([
    z.object({
      action: z.literal("set_desktop_size"),
      size: z.enum(["full_hd", "large_16_9", "social_16_9"]),
    }),
    z.object({
      action: z.literal("launch"),
      app: z.literal("xterm"),
      instance: z.enum(["primary", "secondary"]).optional().default("primary"),
    }),
    z.object({
      action: z.literal("focus"),
      app: z.literal("firefox"),
    }),
    z.object({
      action: z.literal("focus"),
      app: z.literal("xterm"),
      instance: z.enum(["primary", "secondary"]).optional().default("primary"),
    }),
    z.object({
      action: z.literal("arrange_pair"),
      pair: z.enum(["terminal_browser", "terminal_terminal"]),
      waitForMs: z.number().int().min(0).max(10_000).optional().default(5_000),
    }),
    arrangeWindowsSchema,
    z.object({
      action: z.literal("window_layout"),
      app: z.literal("desktop"),
      layout: z.enum(["maximized", "left", "right"]),
    }),
    z.object({
      action: z.literal("launch"),
      app: z.literal("firefox"),
      url: browserUrl.optional(),
    }),
  ]),
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("screenshot"), path: screenshotFileName.optional() }),
    z.object({
      action: z.literal("click"),
      x: coordinate.max(SCREEN_WIDTH - 1),
      y: coordinate.max(SCREEN_HEIGHT - 1),
      button,
      keys: modifierKeys,
      durationMs: pointerDurationMs,
      movementStyle,
    }),
    z.object({
      action: z.literal("double_click"),
      x: coordinate.max(SCREEN_WIDTH - 1),
      y: coordinate.max(SCREEN_HEIGHT - 1),
      button,
      keys: modifierKeys,
      durationMs: pointerDurationMs,
      movementStyle,
    }),
    z.object({
      action: z.literal("triple_click"),
      x: coordinate.max(SCREEN_WIDTH - 1),
      y: coordinate.max(SCREEN_HEIGHT - 1),
      button,
      keys: modifierKeys,
      durationMs: pointerDurationMs,
      movementStyle,
    }),
    z.object({
      action: z.literal("drag"),
      path: z.array(dragPoint).min(2).max(100),
      keys: modifierKeys,
      movementStyle: precisionMovementStyle,
      durationMs: pointerDurationMs,
    }),
    z.object({
      action: z.literal("keypress"),
      keys: z.array(key).min(1).max(4),
    }),
    z.object({
      action: z.literal("move"),
      x: coordinate.max(SCREEN_WIDTH - 1),
      y: coordinate.max(SCREEN_HEIGHT - 1),
      keys: modifierKeys,
      durationMs: pointerDurationMs,
      movementStyle,
    }),
    z.object({
      action: z.literal("scroll"),
      x: coordinate.max(SCREEN_WIDTH - 1),
      y: coordinate.max(SCREEN_HEIGHT - 1),
      scroll_x: z.number().finite().min(-10_000).max(10_000),
      scroll_y: z.number().finite().min(-10_000).max(10_000),
      keys: modifierKeys,
    }),
    typeActionSchema,
    z.object({
      action: z.literal("clipboard_read"),
      selection: z.enum(["clipboard", "primary"]),
    }),
    z.object({
      action: z.literal("clipboard_write"),
      selection: z.enum(["clipboard", "primary"]),
      text: z.string().max(10_000),
    }),
    z.object({
      action: z.literal("wait"),
      durationMs: z.number().int().min(100).max(10_000).optional().default(2_000),
    }),
    z.object({ action: z.literal("record_start"), path: recordingFileName.optional() }),
    z.object({ action: z.literal("record_stop") }),
    z.object({
      action: z.literal("sequence"),
      actions: z.array(sequenceActionSchema).min(1).max(30),
    }),
  ]),
]);

export default defineTool({
  description:
    "Execute an OpenAI computer-use action against the isolated X11 desktop. Use set_desktop_size before launching managed windows to select full_hd (1920x1080), large_16_9 (1600x900), or social_16_9 (1280x720); smaller desktops make fixed-size UI and terminal text occupy more of the recording. " +
    "Each action runs through Cua Driver and returns a fresh screenshot path plus the foreground application grounding window, pointer position, and bounded accessibility elements with screen coordinates. " +
    "Actions execute without a human approval prompt. " +
    "Use those coordinates for the next action. Use launch with app firefox and an optional HTTP(S) URL for the browser. Use launch with app xterm and instance primary or secondary for up to two managed terminals. Use focus to activate an existing app without changing its geometry. Use arrange_pair for common 50/50 terminal/browser or two-terminal layouts. Use arrange_windows for custom one-to-four-window scenes with proportional regions; it resolves every managed selector before moving any window, rejects overlap and unreadable geometry, waits boundedly for newly opened windows, and verifies the applied scene. Use window_layout with app desktop only for a single active window. Do not launch either application through a shell command. The action shape follows the " +
    "OpenAI computer tool: screenshot, click, double_click, triple_click, drag, keypress, move, scroll, type, clipboard_read, clipboard_write, and wait, plus constrained layout, launch, and recording lifecycle actions. arrange_windows is available inside sequence for a deterministic mid-demo transition after an interaction opens Firefox. Use sequence for a rehearsed recording so up to 30 actions execute in one sandbox round trip with only one final screenshot. " +
    "Pointer movement remains direct when movementStyle is omitted, preserving faithful exploratory and bug-repro interaction. For polished recordings, explicitly use movementStyle natural for confident curved moves/clicks and precision for drags; precision approaches the drag start naturally, pauses briefly around mouse-down, makes one subtle undershoot and exact correction while held, then pauses before mouse-up. Natural duration is distance-based and deliberately brisk; durationMs can override styled moves, clicks, and drags when exact timing matters. Recording actions return the sandbox path of the MP4 file; recordings stop automatically after five minutes. Requests have a two-minute deadline including queue time. Typing is limited to 10000 characters total per request; paced typing additionally allows at most 1000 graphemes and 30000ms of planned delay across the whole sequence. Omit typingStyle and typingDelayMs for longer text. Paced typing timings retain only the final driver result and grapheme count.",
  inputSchema,
  approval: never(),
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();

    if ("keys" in input && input.action !== "keypress" && input.keys?.length) {
      throw new Error("computer-use pointer action modifiers are not supported");
    }

    if (input.action === "sequence") validateSequenceBudget(input.actions);

    const action =
      input.action === "arrange_pair"
        ? arrangePairAction(input.pair, input.waitForMs)
        : input.action === "sequence"
          ? {
              ...input,
              actions: input.actions.map((nested) =>
                nested.action === "record_start"
                  ? { ...nested, path: recordingPath(sandbox, nested.path) }
                  : nested,
              ),
            }
          : input.action === "record_start"
            ? {
                ...input,
                path: recordingPath(sandbox, input.path ?? `recording-${crypto.randomUUID()}.mp4`),
              }
            : input.action === "scroll"
              ? { ...input, scrollX: input.scroll_x, scrollY: input.scroll_y }
              : input;

    if (
      action.action === "set_desktop_size" ||
      action.action === "launch" ||
      action.action === "focus" ||
      action.action === "window_layout"
    ) {
      const launch = await sandbox.run({
        command:
          action.action === "set_desktop_size"
            ? computerUseDesktopSizeCommand(sandbox, action.size)
            : action.action === "launch"
              ? computerUseLaunchCommand(sandbox, action)
              : action.action === "focus"
                ? computerUseFocusCommand(
                    sandbox,
                    action.app,
                    action.app === "xterm" ? action.instance : undefined,
                  )
                : computerUseWindowLayoutCommand(sandbox, action.layout),
        abortSignal: ctx.abortSignal,
      });
      ensureSuccess(input.action, launch);
    }

    const screenshot =
      action.action === "screenshot"
        ? screenshotPath(sandbox, action.path)
        : screenshotPath(sandbox);
    const driverAction =
      action.action === "set_desktop_size" ||
      action.action === "launch" ||
      action.action === "focus" ||
      action.action === "window_layout"
        ? { action: "screenshot" as const }
        : action;
    const response = await callComputerUseDriver(
      sandbox,
      computerUseDriverRequest(driverAction, screenshot),
      ctx.abortSignal,
    );
    if (response.screenshot !== screenshot) {
      throw new Error("computer-use driver returned an unexpected screenshot path");
    }

    const output: {
      action: typeof input.action;
      result?: unknown;
      backend: typeof response.backend;
      timings?: unknown;
      path: string | null;
      screenshot: string;
      state: string;
      version: typeof response.version;
    } = {
      action: input.action,
      backend: response.backend,
      path:
        action.action === "screenshot"
          ? screenshot
          : action.action === "record_start"
            ? action.path
            : action.action === "sequence"
              ? (action.actions.find((nested) => nested.action === "record_start")?.path ?? null)
              : null,
      screenshot,
      state: response.state,
      version: response.version,
    };
    if (input.action === "clipboard_read" || input.action === "clipboard_write") {
      output.result = response.action;
    }
    if (action.action === "sequence") output.timings = response.action;
    return output;
  },
});

async function callComputerUseDriver(
  sandbox: Pick<SandboxSession, "resolvePath" | "run">,
  request: ReturnType<typeof computerUseDriverRequest>,
  abortSignal: AbortSignal | undefined,
): Promise<z.infer<typeof driverResponseSchema>> {
  const result = await sandbox.run({
    command: computerUseDriverCommand(sandbox),
    env: {
      COMPUTER_USE_REQUEST: JSON.stringify(request),
      COMPUTER_USE_SOCKET_PATH: computerUsePaths(sandbox).driverSocket,
    },
    abortSignal,
  });
  ensureSuccess(request.action.action, result);
  try {
    return driverResponseSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error("computer-use driver returned an invalid response", { cause: error });
  }
}

function arrangePairAction(
  pair: "terminal_browser" | "terminal_terminal",
  waitForMs: number,
): z.infer<typeof arrangeWindowsSchema> {
  const leftSelector =
    pair === "terminal_browser"
      ? ({ app: "firefox" } as const)
      : ({ app: "xterm", instance: "primary" } as const);
  const rightSelector =
    pair === "terminal_browser"
      ? ({ app: "xterm", instance: "primary" } as const)
      : ({ app: "xterm", instance: "secondary" } as const);
  return {
    action: "arrange_windows",
    waitForMs,
    windows: [
      { selector: leftSelector, region: { x: 0, y: 0, width: 0.5, height: 1 } },
      { selector: rightSelector, region: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ],
  };
}

function validateSequenceBudget(actions: readonly z.infer<typeof sequenceActionSchema>[]): void {
  const textLength = actions.reduce(
    (total, action) => total + (action.action === "type" ? action.text.length : 0),
    0,
  );
  const startIndexes = actions.flatMap((action, index) =>
    action.action === "record_start" ? [index] : [],
  );
  const stopIndexes = actions.flatMap((action, index) =>
    action.action === "record_stop" ? [index] : [],
  );
  const starts = startIndexes.length;
  const stops = stopIndexes.length;
  if (textLength > 10_000)
    throw new Error("computer-use sequence may type at most 10000 characters");
  if (starts > 1 || stops > 1) throw new Error("computer-use sequence may record at most one take");
  if ((starts === 0) !== (stops === 0)) {
    throw new Error("computer-use recording sequence requires one start and one stop");
  }
  if (starts === 1) {
    if (startIndexes[0] !== 0 || stopIndexes[0] !== actions.length - 1) {
      throw new Error("computer-use recording sequence must start first and stop last");
    }
  }
}

function ensureSuccess(action: string, result: { exitCode: number; stderr: string }): void {
  if (result.exitCode !== 0) {
    throw new Error(`computer ${action} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}
