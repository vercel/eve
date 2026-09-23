const FULL_CHANGELOG_URL = "https://eve.dev/changelog";

/** Formats the newest Changesets release entry for the compact TUI command result. */
export function formatCurrentChangelog(changelog: string): string | undefined {
  const match = /^## (\S[^\n]*)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
  if (match === null) return undefined;

  const [, version, body = ""] = match;
  const sections = body
    .trim()
    .split(/^### /m)
    .filter(Boolean)
    .map((section) => {
      const [heading, ...content] = section.trim().split("\n");
      const changes = content
        .join("\n")
        .replace(/^- [a-f0-9]+: /gm, "• ")
        .trim();
      return changes === "" ? undefined : `${heading}\n\n${changes}`;
    })
    .filter((section): section is string => section !== undefined);

  return [`eve ${version}`, ...sections, `Full changelog: ${FULL_CHANGELOG_URL}`].join("\n\n");
}
