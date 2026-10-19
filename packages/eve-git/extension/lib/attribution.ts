import { posix } from "node:path";
import type { SandboxSession } from "eve/sandbox";

/** The person a commit or pull request is created for. */
export interface GitHubCoAuthor {
  readonly email: string;
  readonly name: string;
}

/** Pull request body flags accepted by `gh pr create`. */
const BODY_FLAGS = new Set(["-b", "--body"]);
const BODY_FILE_FLAGS = new Set(["-F", "--body-file"]);
/** A `Key: value` line, the shape of every line in a git trailer block. */
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*: \S/u;

/** Format a validated `Co-authored-by` trailer. */
export function coAuthorTrailer(coAuthor: GitHubCoAuthor): string {
  const name = coAuthor.name.trim();
  const email = coAuthor.email.trim();
  if (!name || /[\r\n<>]/u.test(name)) {
    throw new Error(`Invalid co-author name ${JSON.stringify(coAuthor.name)}.`);
  }
  if (!/^[^\s<>@]+@[^\s<>@]+$/u.test(email)) {
    throw new Error(`Invalid co-author email ${JSON.stringify(coAuthor.email)}.`);
  }
  return `Co-authored-by: ${name} <${email}>`;
}

/**
 * Append a trailer unless the body already carries it. Git and GitHub read
 * only the last paragraph as trailers, so an existing trailer block is
 * extended rather than followed by a new paragraph.
 */
export function withTrailer(body: string, trailer: string): string {
  const lines = body.split(/\r?\n/u).map((line) => line.trim().toLowerCase());
  if (lines.includes(trailer.toLowerCase())) return body;
  const trimmed = body.trimEnd();
  if (!trimmed) return trailer;
  const paragraphs = trimmed.split(/\r?\n[ \t]*\r?\n/u);
  const last = paragraphs.at(-1)!.split(/\r?\n/u);
  const extendsTrailers = paragraphs.length > 1 && last.every((line) => TRAILER_LINE.test(line));
  return `${trimmed}${extendsTrailers ? "\n" : "\n\n"}${trailer}`;
}

/** True for the commands whose bodies carry attribution. */
export function isAttributable(argv: readonly string[]): boolean {
  return (
    argv[0] === "gh-signed-commit" || (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create")
  );
}

/**
 * Add the trailer to the bodies eve publishes: `gh-signed-commit` commit
 * messages and `gh pr create` descriptions. Other commands are unchanged.
 * A `--body-file` is copied to `bodyFile`, so the model's file stays intact.
 */
export async function attributeCommand(
  argv: readonly string[],
  trailer: string,
  sandbox: Pick<SandboxSession, "readTextFile" | "writeTextFile">,
  workingDirectory: string,
  bodyFile: string,
): Promise<string[]> {
  const result = [...argv];
  if (argv[0] === "gh-signed-commit") {
    // gh-signed-commit keeps the last `-b`.
    const index = result.lastIndexOf("-b");
    if (index === -1) result.push("-b", trailer);
    else result[index + 1] = withTrailer(result[index + 1] ?? "", trailer);
    return result;
  }
  if (argv[0] !== "gh" || argv[1] !== "pr" || argv[2] !== "create") return result;
  // gh keeps the last body flag, so attribute that one.
  for (let index = result.length - 1; index >= 3; index -= 1) {
    const value = result[index]!;
    const [flag, inline] = splitInline(value);
    if (BODY_FLAGS.has(flag)) {
      const body = withTrailer(inline ?? result[index + 1] ?? "", trailer);
      if (inline === undefined) result[index + 1] = body;
      else result[index] = `${flag}=${body}`;
      return result;
    }
    if (BODY_FILE_FLAGS.has(flag)) {
      const path = inline ?? result[index + 1];
      if (!path || path === "-") return result;
      const content = await sandbox.readTextFile({ path: posix.resolve(workingDirectory, path) });
      if (content === null)
        throw new Error(`Pull request body file ${JSON.stringify(path)} not found.`);
      await sandbox.writeTextFile({ content: withTrailer(content, trailer), path: bodyFile });
      if (inline === undefined) result[index + 1] = bodyFile;
      else result[index] = `${flag}=${bodyFile}`;
      return result;
    }
  }
  return result;
}

/** Split `--flag=value`, `-fvalue`, and `-f=value` the way gh's flag parser does. */
function splitInline(value: string): [string, string | undefined] {
  if (!value.startsWith("--")) {
    if (!value.startsWith("-") || value.length <= 2) return [value, undefined];
    const rest = value.slice(2);
    return [value.slice(0, 2), rest.startsWith("=") ? rest.slice(1) : rest];
  }
  const separator = value.indexOf("=");
  return separator === -1
    ? [value, undefined]
    : [value.slice(0, separator), value.slice(separator + 1)];
}
