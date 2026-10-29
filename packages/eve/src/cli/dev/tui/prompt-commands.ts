import type { ChannelCommandInfo } from "#client/commands.js";
import { stripAnsi, stripTerminalControls } from "#cli/ui/terminal-text.js";

export type PromptCommandExtensionName = "login" | "model" | "add" | "deploy";

type PromptCommandTarget = "local" | "remote";

/** The slash commands the prompt accepts. */
export type PromptCommand =
  | { type: "exit" }
  | { type: "help" }
  | { type: "info" }
  | { type: "loglevel"; argument: string }
  | { type: "traces"; argument: string }
  | { type: "extension"; name: PromptCommandExtensionName; argument: string }
  /** A command the agent's eve channel offers, run on the server. */
  | { type: "channel"; name: string; argument: string; session: "optional" | "required" };

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
  /** Inline argument suggestions, when this command has a catalog-backed grammar. */
  readonly typeahead?: { readonly maxArguments: number; readonly loadingLabel: string };
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
    typeahead: { maxArguments: 2, loadingLabel: "models" },
    build: (argument) => ({ type: "extension", name: "model", argument }),
    targets: ["local"],
  },
  {
    name: "login",
    history: "omit",
    aliases: [],
    description: "Connect a model provider",
    argumentHint: "[connection]",
    takesArgument: true,
    typeahead: { maxArguments: 1, loadingLabel: "connections" },
    build: (argument) => ({ type: "extension", name: "login", argument }),
    targets: ["local"],
  },
  {
    name: "add",
    history: "omit",
    aliases: [],
    description: "Add an integration from the registry",
    takesArgument: true,
    typeahead: { maxArguments: 1, loadingLabel: "registry" },
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
    description: "Choose the minimum displayed log severity",
    argumentHint: "[none|error|warn|debug|all]",
    takesArgument: true,
    typeahead: { maxArguments: 1, loadingLabel: "log levels" },
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

export type ArgumentTypeaheadCommand = Extract<
  (typeof PROMPT_COMMAND_DEFINITIONS)[number],
  { typeahead: object }
>["name"];

export const PROMPT_COMMANDS: readonly PromptCommandSpec[] = PROMPT_COMMAND_DEFINITIONS;

export function promptCommandsFor(target: PromptCommandTarget): readonly PromptCommandSpec[] {
  const commands = PROMPT_COMMAND_DEFINITIONS.filter((definition) =>
    definition.targets.some((supportedTarget) => supportedTarget === target),
  );
  // Remote sessions have no model picker, so bare `/` leads with /help.
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
 * Recognizes the slash commands the prompt accepts: the TUI's built-ins, plus the eve channel's
 * commands when `commands` includes them, such as `/new`, `/clear`, `/compact`, and `/cancel` from
 * the default channel. Anything else, including unknown `/text`, is a normal message.
 */
export function parsePromptCommand(
  prompt: string,
  commands: readonly PromptCommandSpec[] = PROMPT_COMMANDS,
): PromptCommand | null {
  const match = promptCommandSpec(prompt, commands);
  return match === undefined ? null : match.spec.build(match.argument);
}

/** Resolve an invocation and its history policy from the same command definition. */
export function promptCommandSpec(
  prompt: string,
  commands: readonly PromptCommandSpec[] = PROMPT_COMMANDS,
): { spec: PromptCommandSpec; argument: string } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) return undefined;
  for (const spec of commands) {
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
export function isPromptControlCommand(
  prompt: string,
  commands: readonly PromptCommandSpec[] = PROMPT_COMMANDS,
): boolean {
  return parsePromptCommand(prompt, commands) !== null;
}

/**
 * Appends the eve channel's commands after the built-ins. A built-in name or alias wins, so an
 * agent cannot shadow `/exit` or `/help`. A command without `input` matches only alone, so
 * `/name some text` stays an ordinary message instead of running it.
 */
export function withChannelPromptCommands(
  builtins: readonly PromptCommandSpec[],
  channel: readonly ChannelCommandInfo[],
): readonly PromptCommandSpec[] {
  const taken = new Set(builtins.flatMap((spec) => [spec.name, ...spec.aliases]));
  const added = channel
    .filter((command) => !taken.has(command.name))
    .map((command): PromptCommandSpec => ({
      name: command.name,
      aliases: (command.aliases ?? []).filter((alias) => !taken.has(alias)),
      // The agent's text reaches the terminal, so it can't carry controls or break the row layout.
      description: terminalLine(command.description),
      argumentHint: command.input === undefined ? undefined : terminalLine(command.input.hint),
      takesArgument: command.input !== undefined,
      history: "keep",
      build: (argument) => ({
        type: "channel",
        name: command.name,
        argument,
        session: command.session,
      }),
    }));
  return added.length === 0 ? builtins : [...builtins, ...added];
}

function terminalLine(text: string): string {
  return stripTerminalControls(stripAnsi(text.split(/\r?\n/u, 1)[0] ?? "")).trim();
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
