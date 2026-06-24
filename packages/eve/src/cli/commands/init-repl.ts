import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";

import { createPrompter, type Prompter, type SelectOption } from "#setup/prompter.js";

import { hasInteractiveTerminal } from "./preconditions.js";

// `promptArgs` is each harness's documented way to open its interactive REPL
// seeded with an initial prompt. Most take a bare positional argument; Gemini
// treats a positional as a one-shot query and needs `-i`, and opencode treats a
// positional as a project path and needs `--prompt`.
const positional = (prompt: string) => [prompt];
const CODING_AGENT_REPLS = [
  { command: "claude", label: "Claude Code", promptArgs: positional },
  { command: "codex", label: "Codex", promptArgs: positional },
  { command: "cursor-agent", label: "Cursor", promptArgs: positional },
  { command: "droid", label: "Droid", promptArgs: positional },
  { command: "gemini", label: "Gemini CLI", promptArgs: (prompt: string) => ["-i", prompt] },
  { command: "opencode", label: "opencode", promptArgs: (prompt: string) => ["--prompt", prompt] },
  { command: "pi", label: "Pi", promptArgs: positional },
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

/** The full path of the named REPL's executable on `PATH`, or null if absent. */
export async function resolveCodingAgentRepl(command: CodingAgentRepl): Promise<string | null> {
  const path = process.env.PATH;
  if (path === undefined || path.length === 0) return null;

  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const executableName of executableNames(command)) {
      const candidate = join(directory, executableName);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** True when the named REPL resolves to an executable on the current `PATH`. */
export async function isCodingAgentReplAvailable(command: CodingAgentRepl): Promise<boolean> {
  return (await resolveCodingAgentRepl(command)) !== null;
}

// `focusHint` (not `hint`) so the menu reads like the dev TUI lists: only the
// highlighted row shows its hint, rather than every row at once.
function handoffOptions(
  availableRepls: readonly CodingAgentReplDefinition[],
  agentName: string,
): SelectOption<InitHandoff>[] {
  return [
    {
      value: "eve-dev",
      label: "Start eve dev",
      focusHint: `talk to '${agentName}' in your terminal`,
    },
    ...availableRepls.map((repl) => ({
      value: repl.command,
      label: `Open ${repl.label}`,
      focusHint: `build '${agentName}' using ${repl.label}`,
    })),
  ];
}

/**
 * Offers any locally installed coding-agent REPLs immediately before the
 * existing `eve dev` handoff. Non-interactive sessions, and systems with none
 * of them on `PATH`, keep the prior direct-to-dev behavior.
 */
export async function selectInitHandoff(input: {
  agentName: string;
  deps?: Partial<InitReplDependencies>;
}): Promise<InitHandoff> {
  const dependencies: InitReplDependencies = { ...defaultDependencies, ...input.deps };
  if (!dependencies.hasInteractiveTerminal()) return "eve-dev";

  const availability = await Promise.all(
    CODING_AGENT_REPLS.map(({ command }) => dependencies.isCodingAgentReplAvailable(command)),
  );
  const availableRepls = CODING_AGENT_REPLS.filter((_, index) => availability[index]);
  if (availableRepls.length === 0) return "eve-dev";

  return dependencies.createPrompter().select<InitHandoff>({
    message: "How would you like to continue?",
    options: handoffOptions(availableRepls, input.agentName),
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

// Only PE executables (.exe/.com) can be launched without a shell on Windows;
// .cmd/.bat shims must go through cmd.exe. Everything on POSIX runs directly.
function isDirectlySpawnable(resolvedPath: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return true;
  const extension = extname(resolvedPath).toLowerCase();
  return extension === ".exe" || extension === ".com";
}

interface ReplSpawnPlan {
  file: string;
  args: readonly string[];
  shell: boolean;
  /** False means the prompt is not in argv and the caller must surface it. */
  seeded: boolean;
}

/**
 * Decides how to launch a REPL from its resolved executable path. A directly
 * spawnable executable runs without a shell, so the multi-line prompt passes
 * through argv verbatim. A `.cmd`/`.bat` shim (or an unresolved command) can
 * only run via cmd.exe, which cannot carry the prompt's newlines or
 * metacharacters in an argument, so it launches the bare REPL and reports the
 * prompt as unseeded.
 */
export function replSpawnPlan(
  command: CodingAgentRepl,
  resolvedPath: string | null,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): ReplSpawnPlan {
  if (resolvedPath !== null && isDirectlySpawnable(resolvedPath, platform)) {
    return {
      file: resolvedPath,
      args: codingAgentRepl(command).promptArgs(prompt),
      shell: false,
      seeded: true,
    };
  }
  return { file: command, args: [], shell: platform === "win32", seeded: false };
}

/** Starts the selected coding-agent REPL in the newly initialized project. */
export async function spawnCodingAgentRepl(input: {
  command: CodingAgentRepl;
  cwd: string;
  prompt: string;
  /** Surfaces the prompt when it could not be seeded into the REPL's argv. */
  onPromptUnseeded?: (prompt: string) => void;
  resolvePath?: (command: CodingAgentRepl) => Promise<string | null>;
}): Promise<boolean> {
  const resolvePath = input.resolvePath ?? resolveCodingAgentRepl;
  const plan = replSpawnPlan(input.command, await resolvePath(input.command), input.prompt);
  if (!plan.seeded) {
    input.onPromptUnseeded?.(input.prompt);
  }
  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: input.cwd,
      shell: plan.shell,
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
