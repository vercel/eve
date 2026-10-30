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

/** Free text a command takes after its name. A structured shape can sit beside `hint` later. */
export interface CommandInput {
  /** What to type, shown after the name, such as `"[reason]"`. */
  readonly hint: string;
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
 * What a command leaves for the caller. `message` is shown only to the caller. `send` continues the
 * conversation as the caller: eve delivers it into the command's session as the caller's next
 * message, through the same `onMessage` path as typed input. Only a command that received a
 * `session` may return `send`. Return nothing for a command that only has side effects.
 */
export interface CommandResult {
  readonly message?: string;
  readonly send?: string;
}

interface CommandMetadata {
  /** One-line description shown in command discovery. */
  readonly description: string;
  /**
   * Text the command takes after its name, with a `hint` shown after the name, such as
   * `{ hint: "[reason]" }`. Without `input`, clients run the command only when it's typed alone,
   * so a message that happens to start with its name stays a message.
   */
  readonly input?: CommandInput;
  /** Other names that run this command, such as `["reset"]` for `new`. */
  readonly aliases?: readonly string[];
  // TODO: argument completion, e.g. `complete(argument)`, served to the terminal UI's typeahead.
}

type CommandRun<TContext> = (ctx: TContext) => void | CommandResult | Promise<void | CommandResult>;

/** A slash command the eve channel offers its clients through `eveChannel({ commands })`. */
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

/** Declares a slash command for `eveChannel({ commands })`. */
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

/**
 * The eve channel's default commands: `new` (alias `reset`), `clear`, and `compact`. Cancelling
 * stays with each client, which knows the turn it's showing, such as the terminal UI's `/cancel`
 * or Web Chat's Stop button.
 * `eveChannel({ commands })` adds its own to them; pass `commands` as a function to change or drop
 * them.
 */
export const sessionCommands = {
  new: defineCommand({
    description: "Start a fresh session",
    aliases: ["reset"],
    session: "required",
    async run({ session }) {
      await session.end();
      return { message: "Session ended. The next message starts a new one." };
    },
  }),
  clear: defineCommand({
    description: "Cancel the running turn and clear the session context",
    session: "required",
    async run({ session }) {
      await session.clear();
      return { message: "Clearing the session context." };
    },
  }),
  compact: defineCommand({
    description: "Compact the current session context",
    session: "required",
    async run({ session }) {
      await session.compact();
      return { message: "Compaction requested." };
    },
  }),
} satisfies CommandDefinitions;

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Rejects names a person cannot type as `/name`, and names or aliases two commands share. The
 * 32-character cap matches Slack's slash commands.
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
 * Resolves a typed name or alias to its command and the name it's keyed by, for
 * {@link runCommand}. Only own keys match, so a name like `constructor` never resolves to an
 * inherited member.
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

/** Thrown when text follows a command that takes no argument. */
export class CommandTakesNoArgumentError extends Error {
  readonly commandName: string;

  constructor(commandName: string) {
    super(`/${commandName} takes no argument.`);
    this.name = "CommandTakesNoArgumentError";
    this.commandName = commandName;
  }
}

/**
 * Runs a command found by {@link findCommand} with the same checks as the eve channel. Throws
 * {@link CommandNeedsSessionError} for a `session: "required"` command without `ctx.session`,
 * {@link CommandTakesNoArgumentError} for text after a command without `input`, and an error when
 * a command without a session returns `send`. Returns only the result fields a channel acts on.
 */
export async function runCommand(
  found: { readonly name: string; readonly command: CommandDefinition },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (found.command.session === "required" && ctx.session === undefined) {
    throw new CommandNeedsSessionError(found.name);
  }
  if (found.command.input === undefined && ctx.argument !== "") {
    throw new CommandTakesNoArgumentError(found.name);
  }
  const result = await found.command.run(ctx);
  const normalized: { message?: string; send?: string } = {};
  if (typeof result?.message === "string") normalized.message = result.message;
  if (typeof result?.send === "string" && result.send.trim().length > 0) {
    if (ctx.session === undefined) {
      throw new Error(
        `/${found.name} returned \`send\` without a session. Only a command that received a session can send; mark it session: "required".`,
      );
    }
    normalized.send = result.send;
  }
  return normalized;
}
