import type { GitHubShellInput } from "../../extension/lib/github-shell.ts";

/**
 * The `gh` tool's command validation on `main` at 38e53fcf5, unchanged apart from its error
 * text. It is the acceptance baseline: the parser may accept only commands it accepts.
 */
export function mainAcceptedArgv(input: GitHubShellInput): string[] | undefined {
  try {
    return validate(input);
  } catch {
    return undefined;
  }
}

const ALLOWED_GIT_REMOTE_COMMANDS = new Set(["fetch", "ls-remote", "pull", "push"]);

function parseCommand(command: string): string[] {
  const value = command.trim();
  if (!value) throw new Error("GitHub command must not be empty.");
  const argv: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") throw new Error("unsupported syntax");
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
    } else if (character === '"') {
      quote = "double";
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else if (";&|<>$`(){}".includes(character)) {
      throw new Error("unsupported syntax");
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote) throw new Error("GitHub command contains an unfinished quote or escape.");
  if (started) argv.push(token);
  if (argv.length === 0) throw new Error("GitHub command must not be empty.");
  return argv;
}
function validate(input: GitHubShellInput): string[] {
  const argv = parseCommand(input.command);
  const permission = input.permissions[0];
  if (input.permissions.length !== 1 || permission?.provider !== "github") {
    throw new Error("Exactly one GitHub permission is required.");
  }
  if (permission.access !== "write") {
    throw new Error("GitHub App commands require explicit write-capable access.");
  }
  if (!input.description.trim()) throw new Error("description must describe the intended result.");
  const [executable, subcommand] = argv;
  if (executable === "gh") {
    if (!subcommand) throw new Error("A gh subcommand is required.");
  } else if (executable === "git") {
    if (!subcommand || !ALLOWED_GIT_REMOTE_COMMANDS.has(subcommand)) {
      throw new Error(
        "Authenticated git supports only fetch, ls-remote, pull, and push; clone with gh repo clone.",
      );
    }
  } else if (executable !== "gh-signed-commit") {
    throw new Error(
      "GitHub commands must use gh, an authenticated git remote command, or gh-signed-commit.",
    );
  }
  return argv;
}
