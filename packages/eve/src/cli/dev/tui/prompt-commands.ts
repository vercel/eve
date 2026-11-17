export type PromptCommandExtensionName = "login" | "model" | "add" | "deploy";

type PromptCommandTarget = "local" | "remote";

export type PromptCommand =
  | { type: "new" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "compact" }
  | { type: "exit" }
  | { type: "help" }
  | { type: "info" }
  | { type: "loglevel"; argument: string }
  | { type: "traces"; argument: string }
  | { type: "extension"; name: PromptCommandExtensionName; argument: string };

export interface PromptCommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly takesArgument: boolean;
  readonly history: "keep" | "omit";
  readonly typeahead?: { readonly maxArguments: number; readonly loadingLabel: string };
  readonly build: (argument: string) => PromptCommand;
}

interface PromptCommandDefinition extends PromptCommandSpec {
  readonly targets: readonly PromptCommandTarget[];
}

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
    name: "new",
    history: "keep",
    aliases: ["reset"],
    description: "Start a fresh session",
    takesArgument: false,
    build: () => ({ type: "new" }),
    targets: ["local", "remote"],
  },
  {
    name: "clear",
    history: "keep",
    aliases: [],
    description: "Clear the session context and keep the session",
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
  if (target === "remote") {
    return [
      ...commands.filter((command) => command.name === "help"),
      ...commands.filter((command) => command.name !== "help"),
    ];
  }
  return commands;
}

export function isPromptCommandAvailableFor(
  name: PromptCommandExtensionName,
  target: PromptCommandTarget,
): boolean {
  const definition = PROMPT_COMMAND_DEFINITIONS.find((entry) => entry.name === name);
  const targets: readonly PromptCommandTarget[] | undefined = definition?.targets;
  return targets?.includes(target) ?? false;
}

export function parsePromptCommand(prompt: string): PromptCommand | null {
  const match = promptCommandSpec(prompt);
  return match === undefined ? null : match.spec.build(match.argument);
}

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

export function isPromptControlCommand(prompt: string): boolean {
  return parsePromptCommand(prompt) !== null;
}

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
