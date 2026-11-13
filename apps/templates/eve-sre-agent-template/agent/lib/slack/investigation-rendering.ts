import {
  type BlockKitBlock,
  Card,
  type CardElement,
  CardText,
} from "eve/channels/slack";
import {
  type InvestigationEvidence,
  renderCompactInvestigationEvidence,
} from "#lib/evidence.ts";

const SLACK_FALLBACK_TEXT_LIMIT = 39_000;
const SLACK_MARKDOWN_BLOCK_LIMIT = 11_000;
const LEADING_NEWLINE = /^\n/u;

export function formatInitialInvestigationFallbackText(label: string): string {
  const lines = [
    `Investigation Thread for ${label}`,
    "",
    "Check back in this thread for investigation updates and findings.",
  ];

  return lines.join("\n");
}

export function buildInitialInvestigationCard(label: string): CardElement {
  return Card({
    children: [
      CardText(
        "An sre investigation has been triggered. Check back in this thread for updates and findings."
      ),
    ],
    title: `Investigation Thread for ${label}`,
  });
}

export function buildSlackMarkdownBlocks(markdown: string): BlockKitBlock[] {
  const blocks: BlockKitBlock[] = [];
  let rest = markdown.trim();

  while (rest.length > SLACK_MARKDOWN_BLOCK_LIMIT) {
    const newline = rest.lastIndexOf("\n", SLACK_MARKDOWN_BLOCK_LIMIT);
    const cut = newline > 0 ? newline : SLACK_MARKDOWN_BLOCK_LIMIT;
    blocks.push({ text: rest.slice(0, cut), type: "markdown" });
    rest = rest.slice(cut).replace(LEADING_NEWLINE, "");
  }

  if (rest) {
    blocks.push({ text: rest, type: "markdown" });
  }

  return blocks;
}

export function slackFallbackText(text: string): string {
  return text.slice(0, SLACK_FALLBACK_TEXT_LIMIT);
}

/** Blocks and fallback text must render the same answer and evidence; build them together. */
export function buildInvestigationResultMessage(
  answer: string,
  evidence: readonly InvestigationEvidence[]
): { blocks: BlockKitBlock[]; text: string } {
  const footer = renderCompactInvestigationEvidence(evidence);
  return {
    blocks: [
      ...buildSlackMarkdownBlocks(answer),
      { type: "divider" },
      { elements: [{ text: footer, type: "mrkdwn" }], type: "context" },
    ],
    text: slackFallbackText(`${answer.trim()}\n\n${footer}`),
  };
}
