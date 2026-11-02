import { defineTool, type ToolModelOutput } from "eve/tools";
import { z } from "zod";

import { withDesktopCall, type DesktopCall } from "./desktop";

export interface DesktopToolSpec<TSchema extends z.ZodObject, TOutput> {
  readonly description: string;
  readonly inputSchema: TSchema;
  /** The agent-desktop argv for one call, without the binary and global flags. */
  readonly argv: (input: z.infer<TSchema>) => readonly string[];
  /** Keep the tool out of the model's tool list; the model finds it with `eve__search`. */
  readonly deferred?: boolean;
  /**
   * Shapes the envelope's `data` into the tool output. Runs inside the call's
   * deadline, so anything it does in the sandbox shares the call's signal.
   */
  readonly output?: (
    data: unknown,
    call: DesktopCall,
    input: z.infer<TSchema>,
  ) => Promise<TOutput> | TOutput;
  /** What the model sees instead of the full output. */
  readonly toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
}

/** An eve tool that runs one agent-desktop command in the sandbox. */
export function desktopTool<TSchema extends z.ZodObject, TOutput = unknown>(
  spec: DesktopToolSpec<TSchema, TOutput>,
) {
  return defineTool<z.infer<TSchema>, TOutput>({
    description: spec.description,
    inputSchema: spec.inputSchema as never,
    async execute(input, ctx) {
      return await withDesktopCall(ctx, async (call) => {
        const data = await call.run(spec.argv(input));
        return (spec.output ? await spec.output(data, call, input) : data) as TOutput;
      });
    },
    deferred: spec.deferred,
    toModelOutput: spec.toModelOutput,
  });
}

/** `--name value` when set, `--name` for `true`, nothing otherwise. Uses `=` so negative numbers parse. */
export function flag(name: string, value: string | number | boolean | undefined | null): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return [`--${name}`];
  return [`--${name}=${value}`];
}

/** One `--name=value` per entry. */
export function repeated(name: string, values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => `--${name}=${value}`);
}

export const ref = z
  .string()
  .describe(
    'Qualified element ref from the latest snapshot or find, like "@s8f3k2p9:e12". Refs expire when the UI changes.',
  );

export const point = z
  .string()
  .describe('An element ref like "@s8f3k2p9:e12", or screen coordinates as "x,y".');

/** A ref goes to `refFlag` (or stays positional without one); coordinates go to `xyFlag`. */
export function pointArgs(target: string, refFlag: string | undefined, xyFlag: string): string[] {
  if (target.startsWith("@")) return refFlag ? [`--${refFlag}=${target}`] : [target];
  return [`--${xyFlag}=${target}`];
}

export const timeoutMs = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Maximum wait in milliseconds for the ref to resolve and become actionable (default 5000).",
  );

export const app = z
  .string()
  .optional()
  .describe(
    "Application name as list_apps prints it, such as gnome-calculator. Not a window title.",
  );

export const windowId = z
  .string()
  .optional()
  .describe("Window id from list_windows; use it when an app has several windows.");

export const surface = z
  .enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"])
  .optional()
  .describe("Surface to read instead of the main window, such as an open menu or dialog.");

/** Tools that act on one ref and take only an optional timeout. */
export function refAction(
  command: string,
  description: string,
  options: { deferred?: boolean } = {},
) {
  return desktopTool({
    description,
    inputSchema: z.object({ ref, timeoutMs }),
    argv: (input) => [command, input.ref, ...flag("timeout-ms", input.timeoutMs)],
    deferred: options.deferred,
  });
}

/** Tools that act on one app window, selected by app name or window id. */
export function windowAction(command: string, description: string) {
  return desktopTool({
    description,
    inputSchema: z.object({ app, windowId }),
    argv: (input) => [command, ...flag("app", input.app), ...flag("window-id", input.windowId)],
    deferred: true,
  });
}
