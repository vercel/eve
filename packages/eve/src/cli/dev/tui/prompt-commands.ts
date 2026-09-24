export type PromptCommandExtensionName = "login" | "model" | "add" | "deploy";

type PromptCommandTarget = "local" | "remote";

/** The slash commands the prompt accepts. */
export type PromptCommand =
  | { type: "reset" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "compact" }
  | { type: "exit" }
  | { type: "help" }
  | { type: "info" }
  | { type: "loglevel"; argument: string }
  | { type: "traces"; argument: string }
  | { type: "extension"; name: PromptCommandExtensionName; argument: string };

/**
 * Metadata for one slash command. The registry describes commands — their
 * names, aliases, and discovery copy — it never executes them: dispatch stays
 * with the runner and the prompt-command handler.
 */
export interface PromptCommandSpec {
  /** Canonical name without the slash, e.g. "model". */
  readonly name: string;
  readonly aliases: readonly string[];
  /** One-line discovery copy shown by the typeahead. */
  readonly description: string;
  /** Optional argument shape shown dim after the name, e.g. "[provider/model]". */
  readonly argumentHint?: string;
  /** Accepts a trailing argument (enables `/name <arg>` parsing). */
  readonly takesArgument: boolean;
  /** Whether recalling this command would reopen a modal or take over prompt navigation. */
  readonly history: "keep" | "omit";
  /** Maps a recognized invocation to its parsed command. */
  readonly build: (argument: string) => PromptCommand;
}

interface PromptCommandDefinition extends PromptCommandSpec {
  readonly targets: readonly PromptCommandTarget[];
}

/**
 * Every slash command the prompt accepts, in typeahead display order. One
 * module owns the command list so the runner's dispatch, the renderer's
 * transcript-echo suppression, and command discovery cannot drift apart.
 */
const PROMPT_COMMAND_DEFINITIONS = [
  {
    name: "model",
    history: "omit",
    aliases: [],
    description: "Choose a model, speed, and reasoning",
    argumentHint: "[provider/model]",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "model", argument }),
    targets: ["local"],
  },
  {
    name: "reset",
    history: "keep",
    aliases: [],
    description: "Start a fresh session",
    takesArgument: false,
    build: () => ({ type: "reset" }),
    targets: ["local", "remote"],
  },
  {
    name: "clear",
    history: "keep",
    aliases: ["new"],
    description: "Clear the current session context",
    takesArgument: false,
    build: () => ({ type: "clear" }),
    targets: ["local", "remote"],
  },
  {
    name: "compact",
    history: "keep",
    aliases: [],
    description: "Compact the current session context",
    takesArgument: false,
    build: () => ({ type: "compact" }),
    targets: ["local", "remote"],
  },
  {
    name: "cancel",
    history: "keep",
    aliases: [],
    description: "Cancel the running turn",
    takesArgument: false,
    build: () => ({ type: "cancel" }),
    targets: ["local", "remote"],
  },
  {
    name: "login",
    history: "omit",
    aliases: [],
    description: "Connect a model provider",
    argumentHint: "[connection]",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "login", argument }),
    targets: ["local"],
  },
  {
    name: "add",
    history: "omit",
    aliases: [],
    description: "Add an integration from the registry",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "add", argument }),
    targets: ["local"],
  },
  {
    name: "deploy",
    history: "keep",
    aliases: [],
    description: "Deploy the agent to Vercel",
    takesArgument: false,
    build: () => ({ type: "extension", name: "deploy", argument: "" }),
    targets: ["local"],
  },
  {
    name: "traces",
    history: "omit",
    aliases: [],
    description: "Open the local trace viewer",
    argumentHint: "[trace]",
    takesArgument: true,
    build: (argument) => ({ type: "traces", argument }),
    targets: ["local"],
  },
  {
    name: "loglevel",
    history: "omit",
    aliases: [],
    description: "Show or hide captured stdout/stderr/sandbox logs",
    argumentHint: "[all|stderr|sandbox|none]",
    takesArgument: true,
    build: (argument) => ({ type: "loglevel", argument }),
    targets: ["local", "remote"],
  },
  {
    name: "info",
    history: "omit",
    aliases: [],
    description: "Show application and messaging information",
    takesArgument: false,
    build: () => ({ type: "info" }),
    targets: ["local"],
  },
  {
    name: "help",
    history: "omit",
    aliases: [],
    description: "Show available commands",
    takesArgument: false,
    build: () => ({ type: "help" }),
    targets: ["local", "remote"],
  },
  {
    name: "exit",
    history: "keep",
    aliases: ["quit"],
    description: "Quit the TUI",
    takesArgument: false,
    build: () => ({ type: "exit" }),
    targets: ["local", "remote"],
  },
] satisfies readonly PromptCommandDefinition[];

export const PROMPT_COMMANDS: readonly PromptCommandSpec[] = PROMPT_COMMAND_DEFINITIONS;

export function promptCommandsFor(target: PromptCommandTarget): readonly PromptCommandSpec[] {
  const commands = PROMPT_COMMAND_DEFINITIONS.filter((definition) =>
    definition.targets.some((supportedTarget) => supportedTarget === target),
  );
  // Remote sessions have no model picker, so keep bare `/` from defaulting to reset.
  if (target === "remote") {
    return [
      ...commands.filter((command) => command.name === "help"),
      ...commands.filter((command) => command.name !== "help"),
    ];
  }
  return commands;
}

/** Whether a command runs against this target — the one authority dispatch shares with discovery. */
export function isPromptCommandAvailableFor(
  name: PromptCommandExtensionName,
  target: PromptCommandTarget,
): boolean {
  const definition = PROMPT_COMMAND_DEFINITIONS.find((entry) => entry.name === name);
  const targets: readonly PromptCommandTarget[] | undefined = definition?.targets;
  return targets?.includes(target) ?? false;
}

/**
 * Recognizes the slash commands the prompt accepts. `/reset` clears the
 * session and transcript; `/cancel` stops the running turn; `/clear` (and
 * `/new`) clears context; `/compact` queues context compaction; `/exit` (and
 * `/quit`) terminate the TUI like Ctrl+C; extension commands are dispatched
 * outside the runner. Anything else — including unknown `/text` — is a normal
 * message.
 */
export function parsePromptCommand(prompt: string): PromptCommand | null {
  const match = promptCommandSpec(prompt);
  return match === undefined ? null : match.spec.build(match.argument);
}

/** Resolve an invocation and its history policy from the same command definition. */
export function promptCommandSpec(
  prompt: string,
): { spec: PromptCommandSpec; argument: string } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return undefined;
  for (const spec of PROMPT_COMMANDS) {
    for (const alias of [spec.name, ...spec.aliases]) {
      const token = `/${alias}`;
      if (trimmed === token) return { spec, argument: "" };
      if (spec.takesArgument && trimmed.startsWith(`${token} `)) {
        return { spec, argument: trimmed.slice(token.length).trim() };
      }
    }
  }
  return undefined;
}

/** True for prompts that are commands, which never echo as user messages. */
export function isPromptControlCommand(prompt: string): boolean {
  return parsePromptCommand(prompt) !== null;
}

/**
 * The table `/help` prints: one line per command — slash name, argument
 * hint, and aliases padded into a column, description after.
 */
export function formatPromptCommandHelp(
  commands: readonly PromptCommandSpec[] = PROMPT_COMMANDS,
): string {
  const entries = commands.map((spec) => {
    const hint = spec.argumentHint === undefined ? "" : ` ${spec.argumentHint}`;
    const aliases = spec.aliases.map((alias) => ` (/${alias})`).join("");
    return { invocation: `/${spec.name}${hint}${aliases}`, description: spec.description };
  });
  const column = Math.max(...entries.map((entry) => entry.invocation.length)) + 2;
  return entries.map((entry) => entry.invocation.padEnd(column) + entry.description).join("\n");
}
