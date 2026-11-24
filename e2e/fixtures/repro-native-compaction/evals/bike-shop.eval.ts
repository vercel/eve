import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineEval } from "eve/evals";

import { EXPECTED_RECIPIENTS, RECIPIENT_COUNT, TASK, topProduct } from "../agent/data.js";

interface Request {
  readonly index: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number | undefined;
  readonly afterCompaction: number;
}

interface CompactionRecord {
  readonly result:
    | "unchanged"
    | {
        readonly messages: readonly {
          readonly role: string;
          readonly parts: readonly string[] | string;
        }[];
        readonly estimatedTokensWithoutEncryptedContent: number;
        readonly estimatedTokensIfEncryptedContentWereText: number;
      };
}

function readCompactionLog(dir: string | undefined): CompactionRecord[] {
  if (dir === undefined || !existsSync(join(dir, "compaction.jsonl"))) return [];
  return readFileSync(join(dir, "compaction.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CompactionRecord);
}

export default defineEval({
  description:
    "Bike shop: 400 customers behind paginated tools. Prints repeated reads, completion and cached tokens around each compaction.",
  async test(t) {
    const arm = process.env.COMPACTION_ARM ?? "native";
    const session = await t.session();
    const turn = await session.send(TASK);
    turn.expectOk();

    const reads = new Map<string, number>();
    let repeatedReads = 0;
    let readCalls = 0;
    const drafts = new Map<string, string>();
    for (const call of turn.toolCalls) {
      const input = call.input as Record<string, unknown>;
      if (call.name === "list_customers" || call.name === "get_customer") {
        readCalls += 1;
        const key = `${call.name}:${JSON.stringify(input)}`;
        if (reads.has(key)) repeatedReads += 1;
        reads.set(key, (reads.get(key) ?? 0) + 1);
      }
      if (call.name === "save_draft") {
        drafts.set(String(input.customerId), String(input.body));
      }
    }
    const correctDrafts = EXPECTED_RECIPIENTS.filter((customer) => {
      const body = drafts.get(customer.id);
      return body !== undefined && body.includes(topProduct(customer));
    }).length;
    const wrongRecipients = [...drafts.keys()].filter(
      (id) => !EXPECTED_RECIPIENTS.some((customer) => customer.id === id),
    ).length;

    const requests: Request[] = [];
    let compactions = 0;
    const timeline: unknown[] = [];
    for (const event of turn.events) {
      if (event.type === "context.settled" && event.data.kind === "compaction") {
        compactions += 1;
        timeline.push({ compactionSettled: event.data.outcome });
      }
      if (event.type === "context.started" && event.data.kind === "compaction") {
        timeline.push({ compactionStarted: event.data.trigger });
      }
      if (
        event.type === "usage.recorded" &&
        event.data.kind === "model" &&
        event.data.owner !== undefined &&
        "runId" in event.data.owner
      ) {
        const request = {
          index: requests.length + 1,
          inputTokens: event.data.usage.inputTokens,
          cacheReadTokens: event.data.usage.cacheReadTokens,
          afterCompaction: compactions,
        };
        requests.push(request);
        timeline.push({ request });
      }
    }

    const sinceCompaction = (n: number, position: number) =>
      requests.filter((request) => request.afterCompaction === n)[position];
    const perCompaction = Array.from({ length: compactions }, (_, i) => ({
      compaction: i + 1,
      firstRequestAfter: sinceCompaction(i + 1, 0),
      secondRequestAfter: sinceCompaction(i + 1, 1),
    }));

    const log = readCompactionLog(process.env.REPRO_OUT);
    const rewrites = log.filter((entry) => entry.result !== "unchanged");
    const windows = rewrites.map((entry) => {
      const rewrite = entry.result as Exclude<CompactionRecord["result"], "unchanged">;
      return {
        shape: rewrite.messages.map(
          (message) =>
            `${message.role}:${Array.isArray(message.parts) ? message.parts.join("+") : message.parts}`,
        ),
        estimatedTokensWithoutEncryptedContent: rewrite.estimatedTokensWithoutEncryptedContent,
        estimatedTokensIfEncryptedContentWereText:
          rewrite.estimatedTokensIfEncryptedContentWereText,
      };
    });

    const result = {
      arm,
      store: process.env.REPRO_STORE ?? "unset",
      rewrittenCompactions: rewrites.length,
      unchangedCompactions: log.length - rewrites.length,
      windows,
      toolCalls: turn.toolCalls.length,
      readCalls,
      repeatedReads,
      draftsSaved: drafts.size,
      correctDrafts,
      wrongRecipients,
      completed: correctDrafts === RECIPIENT_COUNT && wrongRecipients === 0,
      compactions,
      perCompaction,
      timeline,
    };
    t.log(JSON.stringify({ ...result, timeline: undefined }, null, 2));
    const dir = process.env.REPRO_OUT;
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `result-${arm}-store-${process.env.REPRO_STORE ?? "unset"}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  },
});
