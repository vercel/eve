import { z } from "#compiled/zod/index.js";

/** One slash command an eve channel offers, from `GET /eve/v1/commands`. */
export interface ChannelCommandInfo {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  /** `"required"` commands run only inside a session. */
  readonly session: "optional" | "required";
}

/** Result of running an eve channel slash command. */
export interface ChannelCommandResult {
  /** Text to show the caller. */
  readonly message?: string;
  /** Text to submit as the caller's next message. */
  readonly send?: string;
  /** Session controls the command applied, so a client can mirror them; `end` retires the session. */
  readonly controls?: readonly ("cancel" | "clear" | "compact" | "end")[];
}

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
  controls: z.array(z.enum(["cancel", "clear", "compact", "end"])).optional(),
});
