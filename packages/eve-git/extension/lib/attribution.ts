import { posix } from "node:path";

/** The person a commit or pull request is created for. */
export interface GitHubCoAuthor {
  readonly email: string;
  readonly name: string;
  /**
   * One Markdown line that ends every comment, review, and review reply the
   * turn posts, such as `<sub>Sent using V</sub>`. When it is set, a command
   * that would post a comment the footer cannot be added to is refused. Omit
   * it to post comments unchanged.
   */
  readonly commentFooter?: string;
}

export interface CommandAttribution {
  readonly footer: string | null;
  readonly trailer: string;
}

export interface BodyFiles {
  read(path: string): PromiseLike<string | null>;
  write(content: string): PromiseLike<string>;
}

interface Flag {
  readonly name: string;
  readonly value: string;
  readonly index: number;
  readonly prefix: string | null;
}

interface ParsedArgs {
  readonly flags: readonly Flag[];
  readonly positionals: readonly string[];
}

type CommandKind =
  | "signed-commit"
  | "pr-create"
  | "comment"
  | "api-comment"
  | "api-review-events"
  | "graphql";

const BODY_FLAGS = new Set(["-b", "--body"]);
const BODY_FILE_FLAGS = new Set(["-F", "--body-file"]);
const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);
const API_TYPED_FIELD_FLAGS = new Set(["-F", "--field"]);
const API_BODY_KEYS = new Set(["body", "comments[][body]"]);
const REPO_FLAGS = ["-R", "--repo"];
const GLOBAL_VALUE_FLAGS = new Set([...REPO_FLAGS, "--hostname"]);
const SIGNED_COMMIT_VALUE_FLAGS = new Set(["--repo", "--branch", "--base", "-m", "-b"]);
const COMMENT_VALUE_FLAGS = new Set([...BODY_FLAGS, ...BODY_FILE_FLAGS, ...REPO_FLAGS]);
const PR_CREATE_VALUE_FLAGS = new Set([
  ...COMMENT_VALUE_FLAGS,
  "-a",
  "--assignee",
  "-B",
  "--base",
  "-H",
  "--head",
  "-l",
  "--label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "--recover",
  "-r",
  "--reviewer",
  "-T",
  "--template",
  "-t",
  "--title",
]);
const API_VALUE_FLAGS = new Set([
  ...API_FIELD_FLAGS,
  "--cache",
  "-H",
  "--header",
  "--hostname",
  "--input",
  "-q",
  "--jq",
  "-X",
  "--method",
  "-p",
  "--preview",
  "-t",
  "--template",
]);
const REST_COMMENT_ENDPOINT =
  /^repos\/[^/]+\/[^/]+\/(?:(?:pulls|issues|commits)\/[^/]+\/(?:comments|reviews)(?:\/\d+)?|pulls\/[^/]+\/comments\/\d+\/replies|(?:(?:pulls|issues)\/)?comments\/\d+)$/u;
const REST_REVIEW_EVENTS_ENDPOINT = /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews\/\d+\/events$/u;
const GRAPHQL_COMMENT_MUTATION =
  /\b(?:addComment|addDiscussionComment|addPullRequestReview|addPullRequestReviewComment|addPullRequestReviewThread|addPullRequestReviewThreadReply|submitPullRequestReview|updateIssueComment|updateDiscussionComment|updatePullRequestReview|updatePullRequestReviewComment)\b/u;
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*: \S/u;

const STDIN_COMMENT_REFUSAL =
  "A comment body read from standard input can't carry the attribution footer. Pass the body with --body, or write it to a file and pass --body-file <path>.";
const STDIN_API_REFUSAL =
  "A comment body read from standard input can't carry the attribution footer. Pass it with -f body=<text>, or write it to a file and pass -F body=@<path> or --input <path>.";
const REVIEW_EVENTS_REFUSAL =
  "Submitting a pending review through .../reviews/<id>/events can't carry the attribution footer. Create and submit the review in one call instead: gh api repos/<owner>/<repo>/pulls/<number>/reviews -f event=COMMENT -f body=<text>, adding inline comments with -f 'comments[][path]=<file>' -F 'comments[][line]=<n>' -f 'comments[][body]=<text>'.";
const GRAPHQL_REFUSAL =
  "GraphQL comment and review mutations can't carry the attribution footer. Use REST instead: gh api repos/<owner>/<repo>/pulls/<number>/comments/<comment_id>/replies -f body=<text> to reply in a review thread, gh api repos/<owner>/<repo>/pulls/<number>/reviews -f event=COMMENT -f body=<text> for a review, or gh pr comment <number> --body <text>.";
const STDIN_GRAPHQL_REFUSAL =
  "A GraphQL query read from standard input can't be checked for comment mutations. Pass it with -f query=<text>.";

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

export function commentFooter(coAuthor: GitHubCoAuthor): string | null {
  if (coAuthor.commentFooter === undefined) return null;
  const footer = coAuthor.commentFooter.trim();
  if (!footer || /[\r\n]/u.test(footer)) {
    throw new Error(`Invalid comment footer ${JSON.stringify(coAuthor.commentFooter)}.`);
  }
  return footer;
}

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

export function withFooter(body: string, footer: string): string {
  const trimmed = body.trimEnd();
  if (trimmed.endsWith(footer)) return body;
  return trimmed ? `${trimmed}\n\n${footer}` : footer;
}

export function isAttributable(argv: readonly string[]): boolean {
  return commandKind(argv) !== null;
}

export async function attributeCommand(
  argv: readonly string[],
  attribution: CommandAttribution,
  files: BodyFiles,
  workingDirectory: string,
): Promise<string[] | { readonly refused: string }> {
  const kind = commandKind(argv);
  const result = [...argv];
  const resolve = (path: string) => posix.resolve(workingDirectory, path);
  const replace = (flag: Flag, value: string) => {
    result[flag.index] = flag.prefix === null ? value : `${flag.prefix}=${value}`;
  };
  if (kind === "signed-commit") {
    const body = parseArgs(argv, 1, SIGNED_COMMIT_VALUE_FLAGS).flags.findLast(
      (flag) => flag.name === "-b",
    );
    if (body) replace(body, withTrailer(body.value, attribution.trailer));
    else result.push("-b", attribution.trailer);
    return result;
  }
  if (kind === "pr-create") {
    const body = lastBodyFlag(parseArgs(argv, 1, PR_CREATE_VALUE_FLAGS));
    if (!body) return result;
    if (BODY_FLAGS.has(body.name)) {
      replace(body, withTrailer(body.value, attribution.trailer));
      return result;
    }
    if (!body.value || body.value === "-") return result;
    const content = await files.read(resolve(body.value));
    if (content === null) {
      return { refused: `Pull request body file ${JSON.stringify(body.value)} not found.` };
    }
    replace(body, await files.write(withTrailer(content, attribution.trailer)));
    return result;
  }
  const footer = attribution.footer;
  if (kind === null || footer === null) return result;
  if (kind === "api-review-events") return { refused: REVIEW_EVENTS_REFUSAL };
  if (kind === "comment") {
    const body = lastBodyFlag(parseArgs(argv, 1, COMMENT_VALUE_FLAGS));
    if (!body) return result;
    if (BODY_FLAGS.has(body.name)) {
      replace(body, withFooter(body.value, footer));
      return result;
    }
    if (body.value === "-") return { refused: STDIN_COMMENT_REFUSAL };
    const content = await files.read(resolve(body.value));
    if (content === null) {
      return { refused: `Comment body file ${JSON.stringify(body.value)} not found.` };
    }
    replace(body, await files.write(withFooter(content, footer)));
    return result;
  }
  const { flags } = parseArgs(argv, 1, API_VALUE_FLAGS);
  if (kind === "graphql") {
    const refused = await refuseGraphqlComment(flags, files, resolve);
    return refused === null ? result : { refused };
  }
  const edits: [Flag, () => PromiseLike<string>][] = [];
  for (const flag of flags) {
    if (flag.name === "--input") {
      if (flag.value === "-") return { refused: STDIN_API_REFUSAL };
      const content = await files.read(resolve(flag.value));
      if (content === null) {
        return { refused: `Input file ${JSON.stringify(flag.value)} not found.` };
      }
      const payload = footeredPayload(content, footer);
      if (payload === null) {
        return {
          refused: `Input file ${JSON.stringify(flag.value)} is not a JSON object, so the attribution footer can't be added to its body.`,
        };
      }
      edits.push([flag, () => files.write(payload)]);
      continue;
    }
    if (!API_FIELD_FLAGS.has(flag.name)) continue;
    const separator = flag.value.indexOf("=");
    const key = flag.value.slice(0, separator);
    if (separator === -1 || !API_BODY_KEYS.has(key)) continue;
    const value = flag.value.slice(separator + 1);
    if (!API_TYPED_FIELD_FLAGS.has(flag.name) || !value.startsWith("@")) {
      const footered = `${key}=${withFooter(value, footer)}`;
      edits.push([flag, async () => footered]);
      continue;
    }
    const path = value.slice(1);
    if (path === "-") return { refused: STDIN_API_REFUSAL };
    const content = await files.read(resolve(path));
    if (content === null) {
      return { refused: `Comment body file ${JSON.stringify(path)} not found.` };
    }
    edits.push([flag, async () => `${key}=@${await files.write(withFooter(content, footer))}`]);
  }
  for (const [flag, edit] of edits) replace(flag, await edit());
  return result;
}

function commandKind(argv: readonly string[]): CommandKind | null {
  if (argv[0] === "gh-signed-commit") return "signed-commit";
  if (argv[0] !== "gh") return null;
  const [group, action] = parseArgs(argv, 1, GLOBAL_VALUE_FLAGS).positionals;
  if (group === "pr" && action === "create") return "pr-create";
  if ((group === "pr" || group === "issue") && action === "comment") return "comment";
  if (group === "pr" && action === "review") return "comment";
  if (group !== "api") return null;
  const endpoint = apiPath(parseArgs(argv, 1, API_VALUE_FLAGS).positionals[1] ?? "");
  if (endpoint === "graphql") return "graphql";
  if (REST_REVIEW_EVENTS_ENDPOINT.test(endpoint)) return "api-review-events";
  if (REST_COMMENT_ENDPOINT.test(endpoint)) return "api-comment";
  return null;
}

function apiPath(endpoint: string): string {
  return endpoint
    .replace(/^https:\/\/api\.github\.com(?=\/)/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/^\/+|\/+$/gu, "");
}

function parseArgs(
  argv: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
): ParsedArgs {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const name = separator === -1 ? arg : arg.slice(0, separator);
      if (!valueFlags.has(name)) continue;
      if (separator !== -1) {
        flags.push({ name, value: arg.slice(separator + 1), index, prefix: name });
      } else if (index + 1 < argv.length) {
        index += 1;
        flags.push({ name, value: argv[index]!, index, prefix: null });
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length === 1) {
      positionals.push(arg);
      continue;
    }
    for (let offset = 1; offset < arg.length; offset += 1) {
      const name = `-${arg[offset]}`;
      if (!valueFlags.has(name)) continue;
      const rest = arg.slice(offset + 1);
      if (rest) {
        const value = rest.startsWith("=") ? rest.slice(1) : rest;
        flags.push({ name, value, index, prefix: arg.slice(0, offset + 1) });
      } else if (index + 1 < argv.length) {
        index += 1;
        flags.push({ name, value: argv[index]!, index, prefix: null });
      }
      break;
    }
  }
  return { flags, positionals };
}

function lastBodyFlag({ flags }: ParsedArgs): Flag | undefined {
  return flags.findLast((flag) => BODY_FLAGS.has(flag.name) || BODY_FILE_FLAGS.has(flag.name));
}

function footeredPayload(content: string, footer: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const footered = (value: Record<string, unknown>) =>
    typeof value.body === "string" ? { ...value, body: withFooter(value.body, footer) } : value;
  const next = footered(payload);
  if (Array.isArray(payload.comments)) {
    next.comments = payload.comments.map((comment) =>
      isRecord(comment) ? footered(comment) : comment,
    );
  }
  return JSON.stringify(next);
}

async function refuseGraphqlComment(
  flags: readonly Flag[],
  files: BodyFiles,
  resolve: (path: string) => string,
): Promise<string | null> {
  for (const flag of flags) {
    let query: string | null = null;
    if (flag.name === "--input") {
      if (flag.value === "-") return STDIN_GRAPHQL_REFUSAL;
      query = await files.read(resolve(flag.value));
      if (query === null) return `Input file ${JSON.stringify(flag.value)} not found.`;
    } else if (API_FIELD_FLAGS.has(flag.name) && flag.value.startsWith("query=")) {
      const value = flag.value.slice("query=".length);
      if (!API_TYPED_FIELD_FLAGS.has(flag.name) || !value.startsWith("@")) query = value;
      else if (value === "@-") return STDIN_GRAPHQL_REFUSAL;
      else {
        query = await files.read(resolve(value.slice(1)));
        if (query === null) return `Query file ${JSON.stringify(value.slice(1))} not found.`;
      }
    }
    if (query !== null && GRAPHQL_COMMENT_MUTATION.test(query)) return GRAPHQL_REFUSAL;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
