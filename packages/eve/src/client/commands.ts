import { z } from "#compiled/zod/index.js";
import type { CommandInfo, CommandRunResult } from "#protocol/commands.js";
import { EveError } from "#shared/eve-error.js";

/** One slash command an eve channel offers, from `GET /eve/v1/commands`. */
export type ChannelCommandInfo = CommandInfo;

/** Result of running an eve channel slash command. */
export type ChannelCommandResult = CommandRunResult;

const CONTROLS = ["cancel", "clear", "compact", "end"] as const;

export const ChannelCommandListSchema = z.object({
  ok: z.literal(true),
  commands: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      argumentHint: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      session: z.enum(["optional", "required"]),
    }),
  ),
});

export const ChannelCommandResultSchema = z.object({
  ok: z.literal(true),
  message: z.string().optional(),
  send: z.string().optional(),
  controls: z.array(z.enum(CONTROLS)).optional(),
});

/**
 * Error thrown when a command route answers successfully with a body that is not a recognized
 * command payload: not JSON, or JSON that does not match the current shape, typically a version
 * skew between the deployment and this client. Distinct from `ClientError`, which a failed
 * request throws.
 */
export class CommandResponseError extends EveError {
  static override readonly errorName = "CommandResponseError";
  declare readonly code: "invalid_command_response";
  /** Schema issue summaries, e.g. `"commands.0.session: Invalid option"`. Empty when the body was not JSON. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(
      "invalid_command_response",
      `The server returned an unrecognized response from an eve command route.${detail}`,
    );
    this.issues = issues;
  }
}
