// Rule 52 of guard-invariants.mjs: `harness/hitl/session-state.ts` is the only module that
// touches human-in-the-loop session state. Count what other modules reach past its read view,
// and hold the per-file allowances to the base branch's.
import { execFileSync } from "node:child_process";

/** The module that owns the records. */
export const HITL_SESSION_STATE_FILE = "packages/eve/src/harness/hitl/session-state.ts";

/**
 * The exports of the session-state module any module may use: its read view. The pure helpers
 * over the records' values live in `relays.ts` and `sign-ins.ts`.
 */
const READ_SURFACE = new Set(["holdsHitlRequests", "readHitlState"]);

// Session-state keys of the records, current and retired.
const KEY_RE = String.raw`["'\`]eve\.(?:runtime\.hitl\.(?:approvalState|requests)|runtime\.pendingAuthorization|runtime\.proxyInputRequests)["'\`]`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
// `import { readApprovalState as read }` and `export { readApprovalState as read }`.
const aliasRe = (/** @type {string} */ names) =>
  new RegExp(String.raw`\b(?:${names})\s+as\s+(${IDENT})`, "g");
const NAMESPACE_RE = new RegExp(
  String.raw`\bimport\s+\*\s+as\s+(${IDENT})\s+from\s+["'][^"']*hitl/session-state\.js["']`,
  "g",
);
// `const { readApprovalState: read } = hitl`.
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
const renameRe = (/** @type {string} */ names) =>
  new RegExp(String.raw`\b(?:${names})\s*:\s*(${IDENT})`, "g");

/**
 * The session-state module's private accessors: every value it exports beyond its read surface.
 * @param {string} source the module's source
 * @returns {string[]}
 */
export function hitlStateAccessors(source) {
  const exported = [
    ...source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]);
  return exported.filter((name) => !READ_SURFACE.has(name)).sort();
}

/**
 * Whether a source file names a session-state key. Only the session-state module may.
 * @param {string} source
 */
export function namesHitlStateKey(source) {
  return new RegExp(KEY_RE).test(stripComments(source));
}

/**
 * Uses of private session state in one source file: its keys, and its private accessors called
 * or indexed under their own names or a local alias.
 * @param {string} source
 * @param {readonly string[]} accessors
 */
export function countHitlStateReads(source, accessors) {
  const code = stripComments(source);
  const names = accessors.join("|");
  const aliases = new Set(
    accessors.length === 0
      ? []
      : [
          ...[...code.matchAll(aliasRe(names))].map((match) => match[1]),
          ...[...code.matchAll(DESTRUCTURE_RE)].flatMap(([, list]) =>
            [...list.matchAll(renameRe(names))].map((match) => match[1]),
          ),
        ],
  );
  for (const name of accessors) aliases.delete(name);
  const escape = (/** @type {string} */ name) => name.replace(/\$/g, "\\$");
  const callees = [...accessors, ...aliases].map(escape);
  // `import * as hitl from ".../session-state.js"`, then `hitl.readApprovalState(...)`.
  const namespaces = [...code.matchAll(NAMESPACE_RE)].map((match) => escape(match[1]));
  const use = [
    ...(callees.length === 0 ? [] : [String.raw`(?<![\w$.])(?:${callees.join("|")})\s*[(<.[]`]),
    ...(namespaces.length === 0 || accessors.length === 0
      ? []
      : [String.raw`(?<![\w$.])(?:${namespaces.join("|")})\.(?:${names})\b`]),
  ];
  return code.match(new RegExp([KEY_RE, ...use].join("|"), "g"))?.length ?? 0;
}

/** @param {string} source */
function stripComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/**
 * Allowances the branch adds or raises over its base's. The base without any allowances is the
 * rule's bootstrap, which sets them.
 * @param {Record<string, number>} allowances
 * @param {Record<string, number> | undefined} base
 */
export function allowanceGrowth(allowances, base) {
  if (base === undefined) return [];
  return Object.entries(allowances)
    .filter(([file, now]) => now > (base[file] ?? 0))
    .map(([file, now]) => ({ file, now, was: base[file] ?? 0 }));
}

/**
 * The allowances to hold the branch to: the merge base's with `origin/main`, or, before the rule
 * lands there, those of the branch's commit that introduced them. `undefined` when no commit has.
 * Throws in CI when the base can't be read, so a shallow checkout can't skip the comparison.
 * @param {string} cwd
 * @param {string} baselinePath repo-relative
 * @param {string} key
 * @returns {Record<string, number> | undefined}
 */
export function baseAllowances(cwd, baselinePath, key) {
  const git = (/** @type {string[]} */ args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const allowancesAt = (/** @type {string} */ commit) => {
    const raw = git(["show", `${commit}:${baselinePath}`]);
    return raw === undefined ? undefined : JSON.parse(raw)[key];
  };
  const mergeBase = git(["merge-base", "origin/main", "HEAD"]);
  if (mergeBase === undefined) {
    if (process.env.CI) throw new Error("rule 52: no merge base with origin/main to compare with");
    return undefined;
  }
  const base = allowancesAt(mergeBase);
  if (base !== undefined) return base;
  const commits = git(["rev-list", "--reverse", `${mergeBase}..HEAD`, "--", baselinePath]) ?? "";
  for (const commit of commits.split("\n").filter(Boolean)) {
    const introduced = allowancesAt(commit);
    if (introduced !== undefined) return introduced;
  }
  return undefined;
}
