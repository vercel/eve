import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import type { ComputerBatchParams } from "@onkernel/sdk/resources/browsers/computer";
import { z } from "zod";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import { withVaultScreenshotMask } from "@agent/subagents/browser-agent/lib/vault-screenshot-mask";

const actionSchema = z.object({
  type: z.enum([
    "click_mouse",
    "move_mouse",
    "type_text",
    "press_key",
    "scroll",
    "drag_mouse",
    "set_cursor",
    "sleep",
    "write_clipboard",
    "read_clipboard",
    "screenshot",
    "get_mouse_position",
  ]),
  click_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      num_clicks: z.number().int().min(1).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  move_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  type_text: z
    .object({
      text: z.string(),
      delay: z.number().int().min(0).max(250).optional(),
    })
    .optional(),
  press_key: z
    .object({
      keys: z.array(z.string()),
      duration: z.number().int().min(0).max(2_000).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  scroll: z
    .object({
      x: z.number(),
      y: z.number(),
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  drag_mouse: z
    .object({
      path: z.array(z.array(z.number()).length(2)).min(2),
      button: z.enum(["left", "middle", "right"]).optional(),
      delay: z.number().int().min(0).max(2_000).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
      step_delay_ms: z.number().int().min(0).max(250).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .optional(),
  set_cursor: z.object({ hidden: z.boolean() }).optional(),
  sleep: z
    .object({ duration_ms: z.number().int().min(0).max(2_000) })
    .optional(),
  write_clipboard: z.object({ text: z.string() }).optional(),
  screenshot: z
    .object({
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
    })
    .optional(),
});

const inputSchema = z.object({
  session_id: z.string().min(1),
  actions: z.array(actionSchema).min(1).max(20),
});

const outputSchema = z.object({
  data: z.unknown().optional(),
  message: z.string(),
  mimeType: z.literal("image/png").optional(),
  screenshotBase64: z.string().optional(),
});

export default defineTool({
  description:
    "Execute a bounded batch of computer actions on one browser session. Prefer one batch over repeated calls, keep sleep actions at or below two seconds, and include a screenshot last only when visual inspection is needed; screenshots are delivered directly to the vision model.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    await requireOwnedBrowserSession(scope, input.session_id);

    const computer = kernel.browsers.computer;
    const data: unknown[] = [];
    let pendingActions: ComputerBatchParams.Action[] = [];
    let screenshotBase64: string | undefined;

    const flushPendingActions = async () => {
      if (pendingActions.length === 0) return;
      const actions = pendingActions;
      pendingActions = [];
      await computer.batch(
        input.session_id,
        { actions },
        { signal: context.abortSignal }
      );
    };

    /* oxlint-disable eslint/no-await-in-loop -- Computer actions must execute in user-specified order and batching is flushed at observation boundaries. */
    for (const action of input.actions) {
      const batchAction = toBatchAction(action);
      if (batchAction) {
        pendingActions.push(batchAction);
        continue;
      }

      await flushPendingActions();
      switch (action.type) {
        case "write_clipboard":
          await computer.writeClipboard(
            input.session_id,
            requiredAction(action.write_clipboard, action.type),
            { signal: context.abortSignal }
          );
          break;
        case "read_clipboard":
          data.push(
            await computer.readClipboard(input.session_id, {
              signal: context.abortSignal,
            })
          );
          break;
        case "get_mouse_position":
          data.push(
            await computer.getMousePosition(input.session_id, {
              signal: context.abortSignal,
            })
          );
          break;
        case "screenshot": {
          screenshotBase64 = await withVaultScreenshotMask(
            input.session_id,
            context.abortSignal,
            async () => {
              const response = await computer.captureScreenshot(
                input.session_id,
                action.screenshot,
                { signal: context.abortSignal }
              );
              return Buffer.from(await response.arrayBuffer()).toString(
                "base64"
              );
            }
          );
          break;
        }
        case "click_mouse":
        case "drag_mouse":
        case "move_mouse":
        case "press_key":
        case "scroll":
        case "set_cursor":
        case "sleep":
        case "type_text":
          throw new Error(`Computer action ${action.type} was not batched.`);
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */
    await flushPendingActions();

    return outputSchema.parse({
      data: data.length > 0 ? data : undefined,
      message: `Executed ${String(input.actions.length)} computer action${input.actions.length === 1 ? "" : "s"}.`,
      mimeType: screenshotBase64 ? "image/png" : undefined,
      screenshotBase64,
    });
  },
  toModelOutput(output) {
    if (!output.screenshotBase64) {
      return toolOutput.json({
        data: output.data,
        message: output.message,
      });
    }
    return toolOutput.content([
      toolOutputPart.text(output.message),
      toolOutputPart.file(output.screenshotBase64, {
        mediaType: output.mimeType ?? "image/png",
      }),
    ]);
  },
});

function requiredAction<T>(value: T | undefined, action: string): T {
  if (value === undefined) {
    throw new Error(`Computer action ${action} is missing its payload.`);
  }
  return value;
}

function toBatchAction(
  action: z.infer<typeof actionSchema>
): ComputerBatchParams.Action | null {
  switch (action.type) {
    case "click_mouse":
      return {
        click_mouse: requiredAction(action.click_mouse, action.type),
        type: action.type,
      };
    case "move_mouse":
      return {
        move_mouse: requiredAction(action.move_mouse, action.type),
        type: action.type,
      };
    case "type_text":
      return {
        type: action.type,
        type_text: requiredAction(action.type_text, action.type),
      };
    case "press_key":
      return {
        press_key: requiredAction(action.press_key, action.type),
        type: action.type,
      };
    case "scroll":
      return {
        scroll: requiredAction(action.scroll, action.type),
        type: action.type,
      };
    case "drag_mouse":
      return {
        drag_mouse: requiredAction(action.drag_mouse, action.type),
        type: action.type,
      };
    case "set_cursor":
      return {
        set_cursor: requiredAction(action.set_cursor, action.type),
        type: action.type,
      };
    case "sleep":
      return {
        sleep: requiredAction(action.sleep, action.type),
        type: action.type,
      };
    case "get_mouse_position":
    case "read_clipboard":
    case "screenshot":
    case "write_clipboard":
      return null;
  }
  throw new Error("Unsupported computer action.");
}
