import { classifyTitle, parseSummary } from "../scripts/changeset-format.mjs";
import { pullRequestFor } from "../scripts/changeset-github.mjs";

const pulls = new Map();
const headings = {
  breaking: "Breaking Changes",
  feature: "Features",
  bugfix: "Bug Fixes",
  internal: "Internal",
  other: "Other Changes",
};
const blockLine = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s{4}|#|>|```|~~~|\|)/u;

// A single prose paragraph of details joins the summary so each entry reads as
// one paragraph; anything richer follows the summary as indented blocks.
function renderEntry(summary, details, link) {
  const prose =
    details && !/\n\s*\n/u.test(details) && !details.split("\n").some((l) => blockLine.test(l));
  const body = prose
    ? `${summary}\n${details} ${link}`
    : `${summary} ${link}${details ? `\n\n${details}` : ""}`;
  return `- ${body
    .split("\n")
    .map((line, index) => (index && line ? `  ${line}` : line))
    .join("\n")}`;
}

export default {
  async getReleaseLine(changeset, type) {
    const { summary, details } = parseSummary(changeset.summary, changeset.id);
    if (!pulls.has(changeset.commit))
      pulls.set(changeset.commit, pullRequestFor(changeset.commit, changeset.id));
    const pull = await pulls.get(changeset.commit);
    // Pre-1.0, a minor bump is how a changeset declares a breaking change.
    let category = type === "major" || type === "minor" ? "breaking" : undefined;
    if (!category) {
      try {
        category = classifyTitle(pull.subject);
      } catch {
        category = "other";
        console.warn(
          `Changeset ${changeset.id}: commit subject has no release category; review the compare link.`,
        );
      }
    }
    const link = `([#${pull.number}](https://github.com/vercel/eve/pull/${pull.number}))`;
    return `#### ${headings[category]}\n\n${renderEntry(summary, details, link)}`;
  },
  getDependencyReleaseLine(_changesets, dependencies) {
    if (!dependencies.length) return "";
    return `#### Dependencies\n\n${dependencies.map(({ name, newVersion }) => `- Updated ${name} to ${newVersion}.`).join("\n")}`;
  },
};
