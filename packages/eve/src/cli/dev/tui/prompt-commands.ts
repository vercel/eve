export type PromptCommandExtensionName =
  | "model"
  | "channels"
  | "deploy"
  | "vc:install"
  | "vc:login";

type PromptCommandTarget = "local" | "remote";

/** The slash commands the prompt accepts. */
export type PromptCommand =
  | { type: "new" }
  | { type: "exit" }
  | { type: "help" }
  | { type: "loglevel"; argument: string }
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
  /** Argument shape shown dim after the name, e.g. "[provider/model]". */
  readonly argumentHint?: string;
  /** Accepts a trailing argument (enables `/name <arg>` parsing). */
  readonly takesArgument: boolean;
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
  // `help` leads so that the typeahead's default highlight — what a bare `/`
  // plus Enter submits — is the safest command, not session-resetting `/new`.
  {
    name: "help",
    aliases: [],
    description: "Show available commands",
    takesArgument: false,
    build: () => ({ type: "help" }),
    targets: ["local", "remote"],
  },
  {
    name: "new",
    aliases: [],
    description: "Start a fresh session",
    takesArgument: false,
    build: () => ({ type: "new" }),
    targets: ["local", "remote"],
  },
  {
    name: "vc:install",
    aliases: [],
    description: "Install the Vercel CLI",
    takesArgument: false,
    build: () => ({ type: "extension", name: "vc:install", argument: "" }),
    targets: ["local", "remote"],
  },
  {
    name: "vc:login",
    aliases: [],
    description: "Authenticate with Vercel",
    takesArgument: false,
    build: () => ({ type: "extension", name: "vc:login", argument: "" }),
    targets: ["local", "remote"],
  },
  {
    name: "model",
    aliases: [],
    description: "Configure the agent's model and provider",
    argumentHint: "[provider/model]",
    takesArgument: true,
    build: (argument) => ({ type: "extension", name: "model", argument }),
    targets: ["local"],
  },
  {
    name: "loglevel",
    aliases: [],
    description: "Show or hide captured stdout/stderr/sandbox logs",
    argumentHint: "[all|stderr|sandbox|none]",
    takesArgument: true,
    build: (argument) => ({ type: "loglevel", argument }),
    targets: ["local", "remote"],
  },
  {
    name: "channels",
    aliases: [],
    description: "Add chat channels to the agent",
    takesArgument: false,
    build: () => ({ type: "extension", name: "channels", argument: "" }),
    targets: ["local"],
  },
  {
    name: "deploy",
    aliases: [],
    description: "Deploy the agent to Vercel",
    takesArgument: false,
    build: () => ({ type: "extension", name: "deploy", argument: "" }),
    targets: ["local"],
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "Quit the TUI",
    takesArgument: false,
    build: () => ({ type: "exit" }),
    targets: ["local", "remote"],
  },
] satisfies readonly PromptCommandDefinition[];

export const PROMPT_COMMANDS: readonly PromptCommandSpec[] = PROMPT_COMMAND_DEFINITIONS;

export function promptCommandsFor(target: PromptCommandTarget): readonly PromptCommandSpec[] {
  return PROMPT_COMMAND_DEFINITIONS.filter((definition) =>
    definition.targets.some((supportedTarget) => supportedTarget === target),
  );
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
 * Recognizes the slash commands the prompt accepts. `/new` clears the
 * session and transcript; `/exit` (and `/quit`) terminate the TUI like
 * Ctrl+C; extension commands are dispatched outside the runner. Anything
 * else — including unknown `/text` — is a normal message.
 */
export function parsePromptCommand(prompt: string): PromptCommand | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return null;
  for (const spec of PROMPT_COMMANDS) {
    for (const alias of [spec.name, ...spec.aliases]) {
      const token = `/${alias}`;
      if (trimmed === token) return spec.build("");
      if (spec.takesArgument && trimmed.startsWith(`${token} `)) {
        return spec.build(trimmed.slice(token.length).trim());
      }
    }
  }
  return null;
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
