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
const SLACK_CONTEXT_TEXT_LIMIT = 3000;
const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_ANSWER_LIMIT = 35_000;
const ANSWER_TRUNCATED = "\n\n[Answer truncated to fit Slack.]";
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
  // Slack caps the combined markdown-block text per message at 12,000.
  const useSections = rest.length > SLACK_MARKDOWN_BLOCK_LIMIT;
  const limit = useSections
    ? SLACK_SECTION_TEXT_LIMIT
    : SLACK_MARKDOWN_BLOCK_LIMIT;
  const block = (text: string): BlockKitBlock =>
    useSections
      ? { text: { text, type: "mrkdwn" }, type: "section" }
      : { text, type: "markdown" };

  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit);
    const cut = newline > 0 ? newline : limit;
    blocks.push(block(rest.slice(0, cut)));
    rest = rest.slice(cut).replace(LEADING_NEWLINE, "");
  }

  if (rest) {
    blocks.push(block(rest));
  }

  return blocks;
}

export function slackFallbackText(text: string): string {
  return text.slice(0, SLACK_FALLBACK_TEXT_LIMIT);
}

function boundedEvidenceFooter(
  evidence: readonly InvestigationEvidence[]
): string {
  if (evidence.length === 0) {
    return renderCompactInvestigationEvidence(evidence);
  }
  const omittedNotice = (count: number) =>
    `\n[${count} evidence items omitted to fit Slack.]`;
  const budget =
    SLACK_CONTEXT_TEXT_LIMIT - omittedNotice(evidence.length).length;
  let footer = "Evidence";
  let included = 0;
  for (const item of evidence) {
    const line = renderCompactInvestigationEvidence([item]).slice(
      "Evidence".length
    );
    // Never slice a source link: a shortened URL can identify another resource.
    if (footer.length + line.length > budget) {
      break;
    }
    footer += line;
    included += 1;
  }
  return included === evidence.length
    ? footer
    : footer + omittedNotice(evidence.length - included);
}

/** Blocks and fallback text must render the same answer and evidence; build them together. */
export function buildInvestigationResultMessage(
  answer: string,
  evidence: readonly InvestigationEvidence[]
): { blocks: BlockKitBlock[]; text: string } {
  const trimmedAnswer = answer.trim();
  const boundedAnswer =
    trimmedAnswer.length > SLACK_ANSWER_LIMIT
      ? trimmedAnswer.slice(0, SLACK_ANSWER_LIMIT - ANSWER_TRUNCATED.length) +
        ANSWER_TRUNCATED
      : trimmedAnswer;
  const footer = boundedEvidenceFooter(evidence);
  return {
    blocks: [
      ...buildSlackMarkdownBlocks(boundedAnswer),
      { type: "divider" },
      { elements: [{ text: footer, type: "mrkdwn" }], type: "context" },
    ],
    text: slackFallbackText(`${boundedAnswer}\n\n${footer}`),
  };
}
