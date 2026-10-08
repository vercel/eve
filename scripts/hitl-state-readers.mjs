// Rule 52 of guard-invariants.mjs: count reads of human-in-the-loop request state, and hold the
// per-file allowances to the base branch's.
import { execFileSync } from "node:child_process";

const ACCESSORS = [
  // Turn state.
  "readTurnState",
  "writeTurnState",
  "queuedInput",
  "suspendedSteps",
  // Response-policy candidates.
  "getApprovalAuditState",
  "getActiveApprovalCandidate",
  "approverOfRequest",
  "retireActiveCandidates",
  // Pending sign-ins.
  "getPendingAuthorization",
  "hasPendingAuthorization",
  "setPendingAuthorization",
  "clearPendingAuthorization",
  // Relay routes.
  "getProxyInputRequests",
  "hasProxyInputRequests",
  "upsertProxyInputRequests",
  "upsertProxyInputRequestState",
  "clearProxyInputRequestsWhere",
  "retireProxyInputRequests",
];
const KEY_RE = String.raw`["'\`]eve\.(?:harness\.turnState|runtime\.hitl\.approvalState|runtime\.pendingAuthorization|runtime\.proxyInputRequests)["'\`]`;
const NAMES = ACCESSORS.join("|");
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
// `import { readTurnState as read }` and `export { readTurnState as read }`.
const IMPORT_ALIAS_RE = new RegExp(String.raw`\b(?:${NAMES})\s+as\s+(${IDENT})`, "g");
// `const { readTurnState: read } = hitl`.
const DESTRUCTURE_RE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
const RENAME_RE = new RegExp(String.raw`\b(?:${NAMES})\s*:\s*(${IDENT})`, "g");

/**
 * Reads of the state in one source file: its session-state keys, and calls of its accessors,
 * under their own names or a local alias.
 * @param {string} source
 */
export function countHitlStateReads(source) {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const aliases = new Set([
    ...[...code.matchAll(IMPORT_ALIAS_RE)].map((match) => match[1]),
    ...[...code.matchAll(DESTRUCTURE_RE)].flatMap(([, names]) =>
      [...names.matchAll(RENAME_RE)].map((match) => match[1]),
    ),
  ]);
  for (const name of ACCESSORS) aliases.delete(name);
  const callees = [...ACCESSORS, ...aliases].map((name) => name.replace(/\$/g, "\\$"));
  const reader = new RegExp(String.raw`${KEY_RE}|(?<![\w$])(?:${callees.join("|")})\s*[(<]`, "g");
  return code.match(reader)?.length ?? 0;
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
