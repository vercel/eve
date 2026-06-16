/** Maximum body length accepted by GitHub issue and pull-request comments. */
export const GITHUB_COMMENT_BODY_MAX_LENGTH = 65_536;

/** Splits a long comment body into GitHub-sized comment bodies. */
export function splitGitHubCommentBody(
  body: string,
  maxLength = GITHUB_COMMENT_BODY_MAX_LENGTH,
): readonly string[] {
  if (body.length <= maxLength) return [body];

  const chunks: string[] = [];
  let remaining = body;
  while (remaining.length > maxLength) {
    const splitAt = findCommentSplitIndex(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function findCommentSplitIndex(value: string, maxLength: number): number {
  const newline = value.lastIndexOf("\n", maxLength);
  if (newline > maxLength * 0.5) return newline;
  const space = value.lastIndexOf(" ", maxLength);
  if (space > maxLength * 0.5) return space;
  return maxLength;
}
