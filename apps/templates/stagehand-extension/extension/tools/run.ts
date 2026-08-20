import type { ExperimentalBatchContext } from "@browserbasehq/stagehand";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getStagehandResources } from "../lib/session.js";

export default defineTool({
  description:
    "Run JavaScript against the active Stagehand page. The code can use page, context, act, observe, and extract, and must return its result.",
  inputSchema: z.object({
    code: z.string().min(1),
  }),
  async execute({ code }) {
    const { stagehand } = await getStagehandResources();
    const result = await stagehand.experimentalBatch(executeCode, code);
    return stringifyResult(result);
  },
});

async function executeCode(batch: ExperimentalBatchContext, code: string): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const execute = new AsyncFunction(
    "page",
    "context",
    "act",
    "observe",
    "extract",
    `"use strict";\n${code}`,
  );
  return execute(batch.page, batch.context, batch.act, batch.observe, batch.extract);
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
