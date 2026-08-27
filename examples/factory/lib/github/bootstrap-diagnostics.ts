/**
 * Translates raw sandbox bootstrap failures (e.g., token minting and cloning) into
 * actionable messages that name `FACTORY_REPO` and the fix, with anything
 * credential-shaped scrubbed before it can reach an error or a log.
 */

/**
 * Upper bound on how much command output is quoted into an error message.
 */
const MAX_DETAIL_LENGTH = 2000;

/**
 * Credential-shaped fragments that must never surface: GitHub token literals,
 * tokens embedded in remote URLs, and authorization header values.
 */
const CREDENTIAL_PATTERNS = [
  /\bgh[a-z]_[A-Za-z0-9_]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /x-access-token:[^@\s"']+/gi,
  /\b(?:authorization|proxy-authorization)\b\s*[:=][^\r\n]*/gi,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Replaces anything credential-shaped in command output with a `[redacted]`
 * marker.
 *
 * @remarks
 * Defense in depth: the installation token is injected at the sandbox
 * firewall and never enters the sandbox, so command output should already be
 * clean, but nothing quoted into an error may depend on that.
 */
export function sanitizeCommandOutput(text: string): string {
  let sanitized = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized;
}

/**
 * Message for the case where the app is definitively the problem: Connect
 * refused to mint an installation token, or GitHub refused the minted token
 * outright.
 */
export function appAccessMessage(repo: string): string {
  return `Cannot access ${repo}. Install the selected GitHub connector's app with access to this repository, then redeploy.`;
}

/**
 * Message for a clone GitHub reported as "not found".
 *
 * @remarks
 * GitHub deliberately reports "not found" both for a repository that does not
 * exist and for a private repository the app cannot see, so this message has
 * to cover both fixes.
 */
export function missingRepoMessage(repo: string): string {
  return `Cannot clone ${repo}: GitHub reports the repository as not found. FACTORY_REPO must reference an existing repository in owner/repo format, and for a private repository the selected GitHub connector's app must be installed with access to it (GitHub reports both cases as not found). Fix FACTORY_REPO or the app installation, then redeploy.`;
}

const NOT_FOUND_EVIDENCE =
  /repository[^\n]{0,200}not found|not found[^\n]{0,200}repository|could not read from remote repository/i;

const AUTHORIZATION_EVIDENCE =
  /authentication failed|authorization|permission denied|forbidden|error:? 403|access denied|invalid[^\n]{0,40}credential/i;

/**
 * Classifies a failed clone from its sanitized output.
 *
 * @remarks
 * A 403 means the token was minted but GitHub rejected it for this repository
 * (app installed, no access); "not found" is ambiguous by design and gets the
 * combined message; anything else surfaces the scrubbed detail as-is.
 *
 * @param repo - The `owner/repo` the clone targeted.
 * @param detail - The failure output; sanitized and bounded before use.
 * @returns The actionable message to raise, naming the repository.
 */
export function describeCloneFailure(repo: string, detail: string): string {
  const safe = sanitizeCommandOutput(detail).slice(0, MAX_DETAIL_LENGTH);
  if (NOT_FOUND_EVIDENCE.test(safe)) {
    return missingRepoMessage(repo);
  }
  if (AUTHORIZATION_EVIDENCE.test(safe)) {
    return appAccessMessage(repo);
  }
  return `Failed to clone ${repo} while building the factory sandbox template. ${safe.trim()}`;
}

/**
 * Message text for an unknown thrown value, sanitized.
 */
export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeCommandOutput(message);
}
