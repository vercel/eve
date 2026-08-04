interface TemplateDiscoveryEntry {
  description: string;
  slug: string;
  title: string;
}

const GENERIC_MARKDOWN_INSTRUCTION =
  "- Page-level Markdown: append .md or .mdx to a documentation URL";
const INTERNAL_GETTING_STARTED_INSTRUCTION =
  "get it as Markdown from /llms.mdx/getting-started (or via /llms.txt)";
const fullDocumentationInstruction = (origin: string): string =>
  `- [Full documentation context](${origin}/llms.txt): All configured documentation as Markdown`;

const escapeMarkdown = (value: string): string => value.replace(/([\\[\]])/g, "\\$1");

export const transformAgentsMarkdown = (
  markdown: string,
  { origin, templates }: { origin: string; templates: TemplateDiscoveryEntry[] },
): string => {
  const upstreamFullDocumentationInstruction = fullDocumentationInstruction(origin);

  if (
    !markdown.includes(GENERIC_MARKDOWN_INSTRUCTION) ||
    !markdown.includes(INTERNAL_GETTING_STARTED_INSTRUCTION) ||
    !markdown.includes(upstreamFullDocumentationInstruction)
  ) {
    throw new Error("Geistdocs agents.md Markdown guidance changed; update the eve transform.");
  }

  const corrected = markdown
    .replace(
      GENERIC_MARKDOWN_INSTRUCTION,
      [
        "- Canonical HTML pages use `/docs/...`, `/integrations/...`, and `/templates/...` URLs.",
        "- Docs and integration pages expose alternate Markdown by appending `.md` or `.mdx` to their canonical HTML URL.",
        "- Template pages are HTML discovery pages; use their setup prompt or source link instead of appending a Markdown extension.",
      ].join("\n"),
    )
    .replace(
      INTERNAL_GETTING_STARTED_INSTRUCTION,
      "get it as Markdown from /docs/getting-started.md (or via /llms.txt)",
    )
    .replace(
      upstreamFullDocumentationInstruction,
      [
        `- [Documentation index](${origin}/llms.txt): Curated task-oriented map of the most useful documentation`,
        `- [Full documentation context](${origin}/llms-full.txt): All configured documentation as Markdown`,
      ].join("\n"),
    );

  const templateLines = templates.map(
    (template) =>
      `- [${escapeMarkdown(`${template.title} template`)}](${origin}/templates/${template.slug}): ${template.description}`,
  );

  return `${corrected.trimEnd()}\n\n## Templates\n\n${templateLines.join("\n")}\n`;
};
