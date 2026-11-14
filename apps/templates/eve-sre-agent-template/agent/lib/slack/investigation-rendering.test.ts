import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import evidenceRecord from "../../tools/evidence_record.ts";
import type { InvestigationEvidenceInput } from "../evidence.ts";
import {
  buildInitialInvestigationCard,
  buildInvestigationResultMessage,
  buildSlackMarkdownBlocks,
  formatInitialInvestigationFallbackText,
  slackFallbackText,
} from "./investigation-rendering.ts";

const ANSWER_EVIDENCE = /^Answer\n\nEvidence\n/u;
const DATADOG = /Datadog/u;
const OMITTED_EVIDENCE = /\d+ evidence items omitted/u;
const SOURCE_LINK = /<([^|]+)\|[^>]+>/gu;
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

  const sections = blocks as { text: { text: string }; type: string }[];
  assert.ok(sections.every((block) => block.type === "section"));
  assert.ok(sections.every((block) => block.text.text.length <= 3000));
  assert.equal(
    sections.map((block) => block.text.text).join(""),
    markdown.replace("\n", "")
  );
  assert.equal(slackFallbackText("a".repeat(40_000)).length, 39_000);
});

test("bounds accepted evidence without cutting links or displacing the answer", () => {
  const schema =
    evidenceRecord.inputSchema as z.ZodType<InvestigationEvidenceInput>;
  const evidence = Array.from({ length: 100 }, (_, index) => ({
    ...schema.parse({
      finding: "f".repeat(500),
      sourceLabel: "Source",
      sourceType: "other",
      sourceUrl:
        index === 0
          ? `https://example.com/${"x".repeat(8172)}`
          : `https://example.com/${index}`,
    }),
    id: `evidence-${index}`,
  }));
  const answer = "The answer must still be delivered.";
  for (const items of [evidence, evidence.slice(1)]) {
    const { blocks, text } = buildInvestigationResultMessage(answer, items);
    const footer = blocks.at(-1) as {
      elements: { text: string; type: string }[];
    };
    assert.ok(footer.elements[0].text.length <= 3000);
    assert.match(footer.elements[0].text, OMITTED_EVIDENCE);
    assert.equal((blocks[0] as { text: string }).text, answer);
    assert.ok(text.startsWith(`${answer}\n\nEvidence\n`));
    // Include complete links only; a truncated URL can point to a different resource.
    for (const match of footer.elements[0].text.matchAll(SOURCE_LINK)) {
      assert.ok(evidence.some((item) => item.sourceUrl === match[1]));
    }
    assert.ok(!footer.elements[0].text.includes("x".repeat(100)));
    if (items[0].sourceUrl.length < 3000) {
      assert.ok(
        footer.elements[0].text.includes("<https://example.com/1|Source>")
      );
    }
    assert.ok(text.length <= 39_000);
  }
});

test("bounds message aggregates and preserves long answers within the budget", () => {
  for (const length of [30_000, 200_000]) {
    const answer = "a".repeat(length);
    const { blocks, text } = buildInvestigationResultMessage(answer, []);
    assert.ok(blocks.length <= 50);
    assert.ok(text.length <= 39_000);
    const answerBlocks = blocks.slice(0, -2) as {
      text: string | { text: string };
      type: string;
    }[];
    const rendered = answerBlocks
      .map((block) =>
        typeof block.text === "string" ? block.text : block.text.text
      )
      .join("");
    for (const block of answerBlocks) {
      assert.ok(
        typeof block.text === "string"
          ? block.text.length <= 12_000
          : block.text.text.length <= 3000
      );
    }
    assert.ok(rendered.length <= 35_000);
    if (length === 30_000) {
      assert.equal(rendered, answer);
    } else {
      assert.ok(rendered.includes("Answer truncated"));
    }
  }
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
