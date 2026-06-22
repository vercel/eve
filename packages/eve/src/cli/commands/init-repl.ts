import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { createPrompter, type Prompter, type SelectOption } from "#setup/prompter.js";

import { hasInteractiveTerminal } from "./preconditions.js";

// `promptArgs` is each harness's documented way to open its interactive REPL
// seeded with an initial prompt. Most take a bare positional argument; Gemini
// treats a positional as a one-shot query and needs `-i`, and opencode treats a
// positional as a project path and needs `--prompt`.
const CODING_AGENT_REPLS = [
  { command: "claude", label: "Claude Code", promptArgs: (prompt: string) => [prompt] },
  { command: "codex", label: "Codex", promptArgs: (prompt: string) => [prompt] },
  { command: "cursor-agent", label: "Cursor", promptArgs: (prompt: string) => [prompt] },
  { command: "droid", label: "Droid", promptArgs: (prompt: string) => [prompt] },
  { command: "gemini", label: "Gemini CLI", promptArgs: (prompt: string) => ["-i", prompt] },
  { command: "opencode", label: "opencode", promptArgs: (prompt: string) => ["--prompt", prompt] },
  { command: "pi", label: "Pi", promptArgs: (prompt: string) => [prompt] },
] as const;

// Node exposes no PATH/PATHEXT-aware executable resolver, so availability is
// probed by hand. `executableNames` reads the OS's own `PATHEXT` first; this
// list is only the fallback for the rare shell that leaves it unset.
const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

type CodingAgentReplDefinition = (typeof CODING_AGENT_REPLS)[number];

/** A coding-agent REPL that can take over the terminal after `eve init`. */
export type CodingAgentRepl = CodingAgentReplDefinition["command"];

/** The one post-init continuation point for a human terminal session. */
export type InitHandoff = "eve-dev" | CodingAgentRepl;

export interface InitReplDependencies {
  createPrompter(): Prompter;
  hasInteractiveTerminal(): boolean;
  isCodingAgentReplAvailable(command: CodingAgentRepl): Promise<boolean>;
}

const defaultDependencies: InitReplDependencies = {
  createPrompter,
  hasInteractiveTerminal,
  isCodingAgentReplAvailable,
};

function executableNames(command: string): readonly string[] {
  if (process.platform !== "win32") return [command];

  const extensions = process.env.PATHEXT?.split(";").filter(Boolean);
  return (extensions && extensions.length > 0 ? extensions : WINDOWS_EXECUTABLE_EXTENSIONS).map(
    (extension) => `${command}${extension}`,
  );
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    if (!(await stat(filePath)).isFile()) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when the named REPL resolves to an executable on the current `PATH`. */
export async function isCodingAgentReplAvailable(command: CodingAgentRepl): Promise<boolean> {
  const path = process.env.PATH;
  if (path === undefined || path.length === 0) return false;

  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const executableName of executableNames(command)) {
      if (await isExecutable(join(directory, executableName))) return true;
    }
  }
  return false;
}

function handoffOptions(
  availableRepls: readonly CodingAgentReplDefinition[],
): SelectOption<InitHandoff>[] {
  return [
    {
      value: "eve-dev",
      label: "Start eve dev",
      hint: "run your agent locally",
    },
    ...availableRepls.map((repl) => ({
      value: repl.command,
      label: `Open ${repl.label}`,
      hint: "open its interactive REPL in this project",
    })),
  ];
}

/**
 * Offers the locally installed coding-agent REPLs immediately before the
 * existing `eve dev` handoff. Non-interactive sessions and systems without
 * either executable keep the prior direct-to-dev behavior.
 */
export async function selectInitHandoff(
  input: {
    deps?: Partial<InitReplDependencies>;
  } = {},
): Promise<InitHandoff> {
  const dependencies: InitReplDependencies = { ...defaultDependencies, ...input.deps };
  if (!dependencies.hasInteractiveTerminal()) return "eve-dev";

  const availability = await Promise.all(
    CODING_AGENT_REPLS.map(({ command }) => dependencies.isCodingAgentReplAvailable(command)),
  );
  const availableRepls = CODING_AGENT_REPLS.filter((_, index) => availability[index]);
  if (availableRepls.length === 0) return "eve-dev";

  return dependencies.createPrompter().select<InitHandoff>({
    message: "How would you like to continue?",
    options: handoffOptions(availableRepls),
    initialValue: "eve-dev",
  });
}

function codingAgentRepl(command: CodingAgentRepl): CodingAgentReplDefinition {
  const definition = CODING_AGENT_REPLS.find((repl) => repl.command === command);
  if (definition === undefined) {
    throw new Error(`Unsupported coding-agent REPL "${command}".`);
  }
  return definition;
}

/** Starts the selected coding-agent REPL in the newly initialized project. */
export function spawnCodingAgentRepl(input: {
  command: CodingAgentRepl;
  cwd: string;
  prompt: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(input.command, codingAgentRepl(input.command).promptArgs(input.prompt), {
      cwd: input.cwd,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
  });
}
