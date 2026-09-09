export function tokenizeToolSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 1);
}

export function scoreToolSearch(
  queryTokens: readonly string[],
  tool: { readonly name: string; readonly description: string },
): number {
  const nameTokens = tokenizeToolSearch(tool.name);
  const descTokens = tokenizeToolSearch(tool.description);
  let score = 0;

  for (const qt of queryTokens) {
    for (const nt of nameTokens) {
      if (nt.includes(qt) || qt.includes(nt)) {
        score += 3;
      }
    }
    for (const dt of descTokens) {
      if (dt.includes(qt) || qt.includes(dt)) {
        score += 1;
      }
    }
  }

  return score;
}
