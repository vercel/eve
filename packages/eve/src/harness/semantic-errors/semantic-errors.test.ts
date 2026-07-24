import { describe, expect, it } from "vitest";

import { summarizeKnownError } from "./index.js";
import { allOf, anyOf, codeIs, evaluateSemanticErrorRules, messageIs, nameIs } from "./rule.js";
import { extractErrorSignals } from "./signals.js";

function named(name: string, message: string, extra?: Record<string, unknown>): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, extra);
}

describe("summarizeKnownError (catalog table)", () => {
  const cases: readonly {
    readonly title: string;
    readonly error: unknown;
    readonly id: string;
  }[] = [
    {
      title: "gateway invalid api key",
      error: named(
        "GatewayAuthenticationError",
        "AI Gateway authentication failed: Invalid API key provided.",
      ),
      id: "gateway-auth-invalid-api-key",
    },
    {
      title: "gateway invalid oidc token",
      error: named(
        "GatewayAuthenticationError",
        "AI Gateway authentication failed: Invalid OIDC token.",
      ),
      id: "gateway-auth-invalid-oidc-token",
    },
    {
      title: "gateway auth without a recognizable variant",
      error: named(
        "GatewayAuthenticationError",
        "AI Gateway authentication failed: No authentication provided.",
      ),
      id: "gateway-auth-missing-credentials",
    },
    {
      title: "gateway model not found by name",
      error: named("GatewayModelNotFoundError", "model not found"),
      id: "model-not-found",
    },
    {
      title: "model not found by gateway body type",
      error: Object.assign(new Error("bad request"), { type: "model_not_found" }),
      id: "model-not-found",
    },
    {
      title: "ai sdk unknown model id",
      error: named("AI_NoSuchModelError", "no such model"),
      id: "model-not-found",
    },
    {
      title: "gateway rate limit",
      error: named("GatewayRateLimitError", "rate limited"),
      id: "gateway-rate-limited",
    },
    {
      title: "gateway upstream overloaded",
      error: Object.assign(new Error("overloaded"), { type: "overloaded_error" }),
      id: "gateway-upstream-unavailable",
    },
    {
      title: "provider api key missing",
      error: named("LoadAPIKeyError", "OpenAI API key is missing."),
      id: "model-provider-api-key-missing",
    },
    {
      title: "empty model response",
      error: named(
        "EmptyModelResponseError",
        "The model did not return a response. Please try again.",
      ),
      id: "empty-model-response",
    },
    {
      title: "unsupported model capability",
      error: named("AI_UnsupportedFunctionalityError", "tool type not supported"),
      id: "model-capability-unsupported",
    },
    {
      title: "workflow store version mismatch",
      error: named("DataDirVersionError", "data dir was created by a newer version"),
      id: "workflow-store-version-mismatch",
    },
    {
      title: "workflow store inaccessible",
      error: named("DataDirAccessError", "EACCES"),
      id: "workflow-store-inaccessible",
    },
    {
      title: "workflow replay divergence",
      error: named("ReplayDivergenceError", "replay diverged at step 3"),
      id: "workflow-replay-divergence",
    },
    {
      title: "workflow event log corrupted",
      error: named("CorruptedEventLogError", "corrupted"),
      id: "workflow-event-log-corrupted",
    },
    {
      title: "workflow run not found",
      error: named("WorkflowRunNotFoundError", "wrun_x not found"),
      id: "workflow-run-not-found",
    },
    {
      title: "docker cli missing",
      error: named("DockerUnavailableError", "Docker CLI not found. Install Docker Desktop."),
      id: "sandbox-docker-cli-missing",
    },
    {
      title: "docker daemon unreachable",
      error: named(
        "DockerDaemonUnavailableError",
        "The Docker sandbox backend requires a running Docker daemon.",
      ),
      id: "sandbox-docker-daemon-unreachable",
    },
    {
      title: "microsandbox provisioning failure",
      error: named("MicrosandboxDiagnosticError", "pulling template [T001]: registry unreachable."),
      id: "sandbox-provisioning-failed",
    },
    {
      title: "port in use",
      error: Object.assign(new Error("listen EADDRINUSE: address already in use"), {
        code: "EADDRINUSE",
      }),
      id: "port-already-in-use",
    },
    {
      title: "disk full",
      error: Object.assign(new Error("write failed"), { code: "ENOSPC" }),
      id: "disk-full",
    },
    {
      title: "network failure by code on the cause chain",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
          code: "ECONNREFUSED",
        }),
      }),
      id: "network-request-failed",
    },
    {
      title: "bare fetch failure without a structured code",
      error: new TypeError("fetch failed"),
      id: "network-request-failed",
    },
  ];

  for (const testCase of cases) {
    it(`classifies ${testCase.title}`, () => {
      expect(summarizeKnownError(testCase.error)?.id).toBe(testCase.id);
    });
  }

  it("prefers the structured code as network evidence over the generic wrapper message", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(summarizeKnownError(error)?.message).toContain("ECONNREFUSED");
  });

  it("splits what happened (message) from what to do (hint)", () => {
    const summary = summarizeKnownError(
      named("GatewayAuthenticationError", "AI Gateway authentication failed: Invalid API key."),
    );
    expect(summary?.message).toBe("AI Gateway rejected the provided API key.");
    expect(summary?.hint).toContain("AI_GATEWAY_API_KEY");
    expect(summary?.message).not.toContain("AI_GATEWAY_API_KEY");
  });

  it("passes structured hints authored at the throw site through", () => {
    const summary = summarizeKnownError(
      named("DockerUnavailableError", "the `docker` CLI was not found.", {
        hint: "Install and start Docker Desktop.",
      }),
    );
    expect(summary?.message).toBe("the `docker` CLI was not found.");
    expect(summary?.hint).toBe("Install and start Docker Desktop.");
  });

  it("passes eve-authored sandbox messages through unchanged", () => {
    const summary = summarizeKnownError(
      named("MicrosandboxDiagnosticError", "pulling template [T001]: registry unreachable."),
    );
    expect(summary?.message).toBe("pulling template [T001]: registry unreachable.");
  });

  it("matches plain-object throwables that crossed a workflow step boundary", () => {
    const summary = summarizeKnownError({
      name: "DataDirVersionError",
      message: "created by a newer version",
    });
    expect(summary?.id).toBe("workflow-store-version-mismatch");
  });

  it("requires exact message equality, never containment", () => {
    expect(summarizeKnownError(new Error("upstream fetch failed for user 42"))).toBeNull();
    expect(summarizeKnownError(new Error("network configuration invalid"))).toBeNull();
  });

  it("returns null for unrecognized errors and non-error throwables", () => {
    expect(summarizeKnownError(new Error("something else went wrong"))).toBeNull();
    expect(summarizeKnownError("string throw")).toBeNull();
    expect(summarizeKnownError(null)).toBeNull();
    expect(summarizeKnownError(undefined)).toBeNull();
  });
});

describe("summary tags", () => {
  it("carries the rule's recovery judgment so classifiers need no second registry", () => {
    expect(
      summarizeKnownError(named("GatewayModelNotFoundError", "model not found"))?.tags,
    ).toContain("config");
    expect(summarizeKnownError(named("GatewayRateLimitError", "rate limited"))?.tags).toContain(
      "transient",
    );
    expect(summarizeKnownError(new TypeError("fetch failed"))?.tags).toContain("transient");
  });
});

describe("rule engine", () => {
  it("evaluates rules in order, first match wins, on any chain link", () => {
    const signals = extractErrorSignals(
      new Error("outer", { cause: Object.assign(new Error("inner"), { code: "X" }) }),
    );
    const summary = evaluateSemanticErrorRules(
      [
        { id: "second", name: "b", tags: ["system"], when: codeIs("X"), message: "late" },
        { id: "first", name: "a", tags: ["system"], when: codeIs("X"), message: "never wins" },
      ],
      signals,
    );
    expect(summary).toEqual({ id: "second", name: "b", tags: ["system"], message: "late" });
  });

  it("allOf requires all predicates on the same link", () => {
    const signals = extractErrorSignals(
      // `name` matches the outer link, `message` only the inner one — no
      // single link satisfies both.
      named("Split", "outer", { cause: new Error("target") }),
    );
    const rule = {
      id: "x",
      name: "x",
      tags: ["system"] as const,
      when: allOf(nameIs("Split"), messageIs("target")),
      message: "m",
    };
    expect(evaluateSemanticErrorRules([rule], signals)).toBeNull();
  });

  it("anyOf matches when either predicate holds", () => {
    const predicate = anyOf(nameIs("A"), codeIs("B"));
    expect(predicate({ message: "", name: "A" })).toBe(true);
    expect(predicate({ message: "", code: "B" })).toBe(true);
    expect(predicate({ message: "" })).toBe(false);
  });
});
