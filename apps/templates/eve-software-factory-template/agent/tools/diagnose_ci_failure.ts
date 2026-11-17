import { defineTool } from "eve/tools";
import { z } from "zod";
import { sanitizeCommandOutput } from "../lib/github/bootstrap-diagnostics.js";
import {
  CI_LOG_CHARACTERS,
  diagnoseCiFailure,
} from "../lib/triage/decisions.js";

export default defineTool({
  description:
    "Classify failed CI evidence as code, flaky, infrastructure, or configuration before spending a revision cycle. Read fresh checks and failed logs with github__getCiFailureContext first, then pass the relevant log here. Empty or unreadable logs return unknown (fix_with_code: null), never a passing verdict. This tool only judges supplied evidence; it cannot rerun CI or change GitHub.",
  async execute({ log }, ctx) {
    const excerpt = sanitizeCommandOutput(log).slice(-CI_LOG_CHARACTERS);
    if (excerpt.trim() === "") {
      return { cause: null, confidence: null, fix_with_code: null };
    }
    return await diagnoseCiFailure(excerpt, { signal: ctx.abortSignal });
  },
  inputSchema: z.object({
    log: z.string().max(32_000),
  }),
});
