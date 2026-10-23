import { type Mock, describe, expect, it, vi } from "vitest";
import type { AgentFeedbackReport } from "./report";
import { type SubmitDeps, submitAgentFeedbackReport } from "./submit";

const report: AgentFeedbackReport = {
  schemaVersion: 1,
  title: "eve dev ignores a renamed tool",
  triggerReason: "misleading-error",
  setup: { deployTarget: "local" },
  steps: ["Rename agent/tools/a.ts to b.ts while eve dev runs"],
  observed: ["The old tool name is still offered"],
  expected: "eve dev picks up the rename.",
  frequency: "once",
  outcome: "resolved",
  eveVersion: "0.12.3",
  agent: "Codex",
};

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  EVE_AGENT_FEEDBACK_ENABLED: "true",
  VERCEL_ENV: "production",
  AGENT_FEEDBACK_INGEST_URL: "https://collector.test/api/v1/feedback",
  AGENT_FEEDBACK_INGEST_TOKEN: "test-token",
};

const form = (value: unknown = report) => {
  const data = new FormData();
  data.set("structuredReport", typeof value === "string" ? value : JSON.stringify(value));
  return data;
};

const deps = (
  overrides: Partial<Omit<SubmitDeps, "fetch">> & { fetch?: Mock<typeof fetch> } = {},
) => ({
  env: productionEnv,
  log: vi.fn(),
  ...overrides,
  fetch: overrides.fetch ?? vi.fn<typeof fetch>(async () => new Response(null, { status: 201 })),
  checkRateLimit: vi.fn(overrides.checkRateLimit ?? (async () => ({ rateLimited: false }))),
});

describe("submitAgentFeedbackReport", () => {
  it("sends a valid report to the collector with the server-only token", async () => {
    const d = deps();

    expect(await submitAgentFeedbackReport(form(), d)).toEqual({ status: "sent" });
    expect(d.fetch).toHaveBeenCalledOnce();
    const [url, init = {}] = d.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://collector.test/api/v1/feedback");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      repo: "eve-external",
      type: "other",
      agentType: "Codex",
      context: { source: "eve.dev/agent-feedback", eveVersion: "0.12.3", report },
    });
  });

  it("rejects malformed submissions without calling out", async () => {
    const d = deps();

    expect(await submitAgentFeedbackReport(form("{"), d)).toEqual({ status: "failed" });
    expect(await submitAgentFeedbackReport(form({ ...report, agent: "" }), d)).toEqual({
      status: "failed",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("honors the kill switch", async () => {
    const d = deps({ env: { ...productionEnv, EVE_AGENT_FEEDBACK_ENABLED: "false" } });

    expect(await submitAgentFeedbackReport(form(), d)).toEqual({ status: "disabled" });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("never sends from preview deployments", async () => {
    const d = deps({ env: { ...productionEnv, VERCEL_ENV: "preview" } });

    expect(await submitAgentFeedbackReport(form(), d)).toEqual({ status: "preview" });
    expect(d.checkRateLimit).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("fails closed without collector config or a rate-limit rule", async () => {
    const noUrl = deps({ env: { ...productionEnv, AGENT_FEEDBACK_INGEST_URL: undefined } });
    expect(await submitAgentFeedbackReport(form(), noUrl)).toEqual({ status: "failed" });

    const noToken = deps({ env: { ...productionEnv, AGENT_FEEDBACK_INGEST_TOKEN: undefined } });
    expect(await submitAgentFeedbackReport(form(), noToken)).toEqual({ status: "failed" });

    const noRule = deps({
      checkRateLimit: async () => ({ rateLimited: false, error: "not-found" }),
    });
    expect(await submitAgentFeedbackReport(form(), noRule)).toEqual({ status: "failed" });
    expect(noRule.fetch).not.toHaveBeenCalled();
  });

  it("reports rate limiting from the firewall and the collector", async () => {
    const limited = deps({ checkRateLimit: async () => ({ rateLimited: true }) });
    expect(await submitAgentFeedbackReport(form(), limited)).toEqual({
      status: "failed",
      rateLimited: true,
    });

    const rejected = deps({
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 429 })),
    });
    expect(await submitAgentFeedbackReport(form(), rejected)).toEqual({
      status: "failed",
      rateLimited: true,
    });
  });
});
