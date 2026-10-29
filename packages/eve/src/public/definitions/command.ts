import type { SessionAuthContext } from "#channel/types.js";

/**
 * The conversation a command was run in, with the caller's auth already bound. Each method
 * resolves once eve has accepted the request; the session applies it at its next boundary, as it
 * does for the same request from a client.
 */
export interface CommandSession {
  readonly id: string;
  /** Cancels the running turn, if there is one. */
  cancel(): Promise<void>;
  /** Clears the session's model-message history and keeps the session. */
  clear(): Promise<void>;
  /** Compacts the session's context. */
  compact(): Promise<void>;
  /** Ends the session. The caller's next message starts a new one. */
  end(): Promise<void>;
}

/** Context passed to a {@link CommandDefinition}'s `run`. */
export interface CommandContext {
  /** Text after the command name, trimmed. Empty when the caller passed none. */
  readonly argument: string;
  /** Who ran the command, such as the eve channel's route-auth result. Authorize side effects against it. */
  readonly caller: SessionAuthContext | null;
  /**
   * The conversation the command was run in, such as the terminal UI's current session. Absent
   * when the client has no session yet.
   */
  readonly session?: CommandSession;
}

/**
 * What a command leaves for the caller. `message` is shown only to the caller. `send` continues
 * the conversation as the caller: the terminal UI submits it as the caller's next message, so the
 * channel's message policy applies to it. Return nothing for a command that only has side effects.
 */
export interface CommandResult {
  readonly message?: string;
  readonly send?: string;
}

interface CommandMetadata {
  /** One-line description shown in command discovery. */
  readonly description: string;
  /**
   * Argument shape shown after the name, such as `"[reason]"`. A command without one takes no
   * argument: clients run it only when it's typed alone, so a message that happens to start with
   * its name stays a message.
   */
  readonly argumentHint?: string;
  /** Other names that run this command, such as `["reset"]` for `new`. */
  readonly aliases?: readonly string[];
  // TODO: argument completion, e.g. `complete(argument)`, served to the terminal UI's typeahead.
}

type CommandRun<TContext> = (ctx: TContext) => void | CommandResult | Promise<void | CommandResult>;

/**
 * A slash command a channel offers, such as through `eveChannel({ commands })`. The definition
 * doesn't depend on a channel, so other channels can offer the same commands.
 */
export interface CommandDefinition extends CommandMetadata {
  /**
   * `"required"` limits the command to a conversation: `run` always receives `session`, and
   * clients don't run the command without one. Defaults to `"optional"`.
   */
  readonly session?: "optional" | "required";
  run(ctx: CommandContext): void | CommandResult | Promise<void | CommandResult>;
}

/** Commands keyed by name, without the slash. */
export type CommandDefinitions = Readonly<Record<string, CommandDefinition>>;

/** Declares a slash command for one or more channels' `commands`. */
export function defineCommand(
  definition: CommandMetadata & {
    readonly session: "required";
    readonly run: CommandRun<CommandContext & { readonly session: CommandSession }>;
  },
): CommandDefinition;
export function defineCommand(
  definition: CommandMetadata & {
    readonly session?: "optional";
    readonly run: CommandRun<CommandContext>;
  },
): CommandDefinition;
export function defineCommand(definition: CommandDefinition): CommandDefinition {
  return definition;
}

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Rejects names a person cannot type as `/name`, and names or aliases two commands share. The
 * 32-character cap matches Slack's, so the same commands can move to other channels.
 */
export function assertCommandNames(
  channel: string,
  commands: CommandDefinitions | undefined,
): void {
  const seen = new Map<string, string>();
  for (const [name, command] of Object.entries(commands ?? {})) {
    for (const token of [name, ...(command.aliases ?? [])]) {
      if (!COMMAND_NAME.test(token)) {
        throw new Error(
          `Invalid ${channel} command name "${token}". Use up to 32 lowercase letters, digits, and hyphens, starting with a letter (for example "triage" or "open-issues"), without the slash.`,
        );
      }
      const owner = seen.get(token);
      if (owner !== undefined) {
        throw new Error(
          `The ${channel} commands "${owner}" and "${name}" both use the name "${token}". Give each command its own name and aliases.`,
        );
      }
      seen.set(token, name);
    }
  }
}

/**
 * Resolves a typed name or alias to its command. Only own keys match, so a name like
 * `constructor` never resolves to an inherited member.
 */
export function findCommand(
  commands: CommandDefinitions | undefined,
  token: string,
): { readonly name: string; readonly command: CommandDefinition } | undefined {
  if (commands === undefined) return undefined;
  if (Object.hasOwn(commands, token)) return { name: token, command: commands[token]! };
  for (const [name, command] of Object.entries(commands)) {
    if (command.aliases?.includes(token) === true) return { name, command };
  }
  return undefined;
}

/** Thrown when a `session: "required"` command runs outside a conversation. */
export class CommandNeedsSessionError extends Error {
  readonly commandName: string;

  constructor(commandName: string) {
    super(`/${commandName} only works inside a conversation.`);
    this.name = "CommandNeedsSessionError";
    this.commandName = commandName;
  }
}

/** Runs a command and keeps only the fields of its result a client reads. */
export async function runCommand(
  found: { readonly name: string; readonly command: CommandDefinition },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (found.command.session === "required" && ctx.session === undefined) {
    throw new CommandNeedsSessionError(found.name);
  }
  const result = await found.command.run(ctx);
  const normalized: { message?: string; send?: string } = {};
  if (typeof result?.message === "string") normalized.message = result.message;
  if (typeof result?.send === "string" && result.send.trim().length > 0) {
    normalized.send = result.send;
  }
  return normalized;
}
