import { z } from "zod";
import { credential, type Config } from "./config.js";
import type { Evidence, Run, Window } from "./types.js";

const endpoint = "https://vercel.com/api/observability/agent-runs";
const record = z.record(z.string(), z.unknown());
const page = z.object({
  runs: z.array(record),
  pageInfo: z.object({
    hasMore: z.boolean(),
    nextOffsets: record.optional(),
    nextCursor: z.string().nullish(),
  }),
  meta: z.object({ dataConfidence: z.string().optional() }).optional(),
});
function epoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
/** Reads an opaque continuation from merged Agent Runs source offsets. */
export function sourceCursor(offsets?: Record<string, unknown>): string | undefined {
  if (!offsets) return;
  const valid = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 10000;
  if (!valid(offsets.otel) || !valid(offsets.workflow)) return;
  const result = [offsets.otel.toString(36), offsets.workflow.toString(36)];
  const range = offsets.otelRange as { from?: unknown; to?: unknown } | undefined;
  if (range !== undefined) {
    if (
      !range ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      (range.from as number) <= 0 ||
      (range.from as number) >= (range.to as number)
    )
      return;
    result.push((range.from as number).toString(36), (range.to as number).toString(36));
  }
  if (offsets.otelCursor !== undefined) {
    if (
      !range ||
      typeof offsets.otelCursor !== "string" ||
      !/^[A-Za-z0-9_-]{1,4096}$/.test(offsets.otelCursor)
    )
      return;
    result.push(offsets.otelCursor);
  }
  return result.join(".");
}
/** Projects provider run metadata into a record without titles, prompts, or raw arguments. */
export function minimizeRun(raw: Record<string, unknown>): Run | undefined {
  const createdAt = epoch(raw.createdAt ?? raw.startedAt);
  if (typeof raw.id !== "string" || typeof raw.status !== "string" || createdAt === undefined)
    return;
  const provenance = raw.provenance as Record<string, unknown> | undefined;
  const usage = raw.usage as Record<string, unknown> | undefined;
  const numeric = (name: string) =>
    typeof usage?.[name] === "number" && Number.isFinite(usage[name]) && usage[name] >= 0
      ? (usage[name] as number)
      : undefined;
  return {
    id: raw.id,
    status: raw.status,
    createdAt,
    completedAt: epoch(raw.completedAt),
    model: typeof raw.model === "string" ? raw.model : undefined,
    deploymentId: typeof raw.deploymentId === "string" ? raw.deploymentId : undefined,
    scheduled: !!provenance?.schedule || raw.trigger === "schedule",
    usage: usage
      ? {
          inputTokens: numeric("inputTokens"),
          outputTokens: numeric("outputTokens"),
          costUsd: numeric("costUsd"),
        }
      : undefined,
  };
}
/** Reads a fixed, bounded Agent Runs window and reports incomplete pagination or provider evidence. */
export async function readAgentRuns(
  c: Config,
  window: Window,
  request: typeof fetch = fetch,
  maxPages = 25,
): Promise<Evidence> {
  if (
    !Number.isSafeInteger(window.from) ||
    !Number.isSafeInteger(window.to) ||
    window.from <= 0 ||
    window.from >= window.to
  )
    throw new Error("Agent Runs requires a fixed absolute window in epoch seconds");
  const token = await credential(c, "vercel");
  const result: Evidence = {
    window,
    complete: false,
    reasons: [],
    runs: [],
    observations: [],
    observationsComplete: false,
  };
  const seen = new Set<string>();
  const runs = new Map<string, Run>();
  let cursor: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({
      teamSlug: c.project.teamId,
      project: c.project.projectId,
      environment: "production",
      from: String(window.from),
      to: String(window.to),
      pageSize: "100",
    }))
      url.searchParams.set(key, value);
    if (cursor) url.searchParams.set("cursor", cursor);
    try {
      const response = await request(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        result.reasons.push(`Agent Runs returned HTTP ${response.status}`);
        break;
      }
      const parsed = page.safeParse(await response.json());
      if (!parsed.success) {
        result.reasons.push("Agent Runs response schema was not recognized");
        break;
      }
      const data = parsed.data;
      if (data.meta?.dataConfidence !== "real") {
        result.reasons.push("Agent Runs did not attest real source data");
        break;
      }
      for (const raw of data.runs) {
        const run = minimizeRun(raw);
        if (!run) {
          result.reasons.push("An Agent Runs row could not be normalized");
          continue;
        }
        runs.set(run.id, run);
      }
      if (!data.pageInfo.hasMore) {
        result.complete = !result.reasons.length;
        break;
      }

      cursor =
        sourceCursor(data.pageInfo.nextOffsets) ??
        (data.pageInfo.nextCursor &&
        /^[0-9a-z]+\.[0-9a-z]+(?:\.[0-9a-z]+\.[0-9a-z]+(?:\.[A-Za-z0-9_-]{1,4096})?)?$/.test(
          data.pageInfo.nextCursor,
        )
          ? data.pageInfo.nextCursor
          : undefined);
      if (!cursor || seen.has(cursor)) {
        result.reasons.push("Continuation is missing or repeated; evidence is truncated");
        break;
      }
      seen.add(cursor);
    } catch {
      result.reasons.push(
        "Agent Runs metadata request failed; credentials and response bodies withheld",
      );
      break;
    }
  }
  if (!result.complete && !result.reasons.length)
    result.reasons.push("Agent Runs page limit reached; evidence is incomplete");
  result.runs = [...runs.values()];
  return result;
}
