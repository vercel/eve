import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInitialInvestigationCard,
  buildInvestigationResultMessage,
  buildSlackMarkdownBlocks,
  formatInitialInvestigationFallbackText,
  slackFallbackText,
} from "./investigation-rendering.ts";

const ANSWER_EVIDENCE = /^Answer\n\nEvidence\n/u;
const DATADOG = /Datadog/u;
const INVESTIGATION_THREAD = /^Investigation Thread for Checkout errors\n/u;

test("initial card and fallback use the investigation label", () => {
  const card = buildInitialInvestigationCard("Checkout errors");
  const fallback = formatInitialInvestigationFallbackText("Checkout errors");

  assert.equal(card.title, "Investigation Thread for Checkout errors");
  assert.match(fallback, INVESTIGATION_THREAD);
});

test("chunks Slack markdown and bounds fallback text", () => {
  const markdown = `${"a".repeat(11_000)}\n${"b".repeat(11_000)}`;
  const blocks = buildSlackMarkdownBlocks(markdown);

  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((block) => (block as { text: string }).text.length),
    [11_000, 11_000]
  );
  assert.equal(slackFallbackText("a".repeat(40_000)).length, 39_000);
});

test("renders evidence in a Slack footer", () => {
  const { blocks, text } = buildInvestigationResultMessage("Answer", [
    {
      finding: "Error rate increased.",
      id: "evidence-1",
      sourceLabel: "Datadog",
      sourceType: "datadog",
      sourceUrl: "https://app.datadoghq.com/",
    },
  ]);

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["markdown", "divider", "context"]
  );
  assert.match(JSON.stringify(blocks.at(-1)), DATADOG);
  assert.match(text, ANSWER_EVIDENCE);
});
