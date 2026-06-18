import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { VercelCaptureResult } from "#setup/primitives/index.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  planTrustedSourceAccess,
  type TrustedSourceEnvironmentRule,
} from "./vercel-trusted-sources-policy.js";
import {
  applyVercelTrustedSourceAccess,
  prepareVercelTrustedSourceAccess,
  type VercelTrustedSourceDeps,
} from "./vercel-trusted-sources.js";

function rule(from: string, to: string): TrustedSourceEnvironmentRule {
  return { from: { slugs: [from] }, to: { slugs: [to] } };
}

const self = {
  projectId: "prj_target",
  environment: "development",
  customEnvironmentSlugs: [] as const,
};

function captureSequence(...results: VercelCaptureResult[]) {
  return vi.fn<VercelTrustedSourceDeps["captureVercel"]>(async () => {
    const result = results.shift();
    if (result === undefined) throw new Error("Unexpected Vercel CLI call");
    return result;
  });
}

function success(value: unknown): VercelCaptureResult {
  return { ok: true, stdout: JSON.stringify(value) };
}

function failure(message: string, stdout = ""): VercelCaptureResult {
  return { ok: false, failure: { code: 1, stdout, stderr: "", message } };
}

function accessDeps(
  captureVercel: VercelTrustedSourceDeps["captureVercel"],
  projectId = "prj_target",
): Partial<VercelTrustedSourceDeps> {
  return {
    captureVercel,
    readProjectLink: async () => ({ orgId: "team_a", projectId }),
  };
}

describe("planTrustedSourceAccess", () => {
  it("leaves the same-project development-to-preview default unchanged", () => {
    expect(
      planTrustedSourceAccess({
        source: self,
        target: { ...self, environment: "preview" },
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("preserves self-access defaults when adding development-to-production", () => {
    expect(
      planTrustedSourceAccess({
        source: self,
        target: { ...self, environment: "production" },
        trustedSources: {
          projects: {
            prj_other: { label: "existing project" },
          },
          oidcProviders: {
            "https://token.actions.githubusercontent.com": [
              { claims: { repository: ["acme/app"] } },
            ],
          },
        },
      }),
    ).toEqual({
      kind: "update",
      trustedSources: {
        projects: {
          prj_other: { label: "existing project" },
          prj_target: {
            customAllow: [
              rule("production", "production"),
              rule("preview", "preview"),
              rule("development", "preview"),
              rule("development", "production"),
            ],
          },
        },
        oidcProviders: {
          "https://token.actions.githubusercontent.com": [{ claims: { repository: ["acme/app"] } }],
        },
      },
    });
  });

  it("appends to explicit rules without restoring defaults the user removed", () => {
    expect(
      planTrustedSourceAccess({
        source: self,
        target: { ...self, environment: "production" },
        trustedSources: {
          projects: {
            prj_target: {
              label: "locked down",
              customAllow: [rule("preview", "preview")],
            },
          },
        },
      }),
    ).toEqual({
      kind: "update",
      trustedSources: {
        projects: {
          prj_target: {
            label: "locked down",
            customAllow: [rule("preview", "preview"), rule("development", "production")],
          },
        },
      },
    });
  });

  it("is idempotent when an existing rule already covers the pair", () => {
    expect(
      planTrustedSourceAccess({
        source: self,
        target: { ...self, environment: "production" },
        trustedSources: {
          projects: {
            prj_target: {
              customAllow: [
                {
                  from: { slugs: ["development", "preview"] },
                  to: { slugs: ["preview", "production"] },
                },
              ],
            },
          },
        },
      }),
    ).toEqual({ kind: "unchanged" });
  });
});

describe("prepareVercelTrustedSourceAccess", () => {
  it("re-reads the target policy immediately before patching", async () => {
    const captureVercel = captureSequence(
      success({ projectId: "prj_target", name: "inbound", target: "production" }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: null,
      }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: {
          projects: { prj_other: { label: "concurrent rule" } },
        },
      }),
      success({ id: "prj_target" }),
    );
    const { prompter } = createFakePrompter({ single: () => "continue" });

    const preparation = await prepareVercelTrustedSourceAccess({
      workspaceRoot: "/repo",
      host: "inbound.example.com",
      prompter,
      deps: accessDeps(captureVercel),
    });
    expect(preparation.kind).toBe("approved");
    if (preparation.kind !== "approved") return;
    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: preparation.grant,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectId: "prj_target" });

    expect(captureVercel).toHaveBeenCalledTimes(4);
    expect(captureVercel).toHaveBeenNthCalledWith(
      4,
      expect.any(Array),
      expect.objectContaining({
        stdin: expect.stringContaining('"prj_other":{"label":"concurrent rule"}'),
      }),
    );
  });

  it("warns before granting the resolved development-to-production pair", async () => {
    const captureVercel = captureSequence(
      success({
        projectId: "prj_target",
        name: "inbound",
        target: "production",
      }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: null,
      }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: null,
      }),
      success({ id: "prj_target" }),
    );
    let prompt: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createFakePrompter({
      single: (options) => {
        prompt = options;
        return "continue";
      },
    });

    const preparation = await prepareVercelTrustedSourceAccess({
      workspaceRoot: "/repo",
      host: "inbound.example.com",
      prompter,
      deps: accessDeps(captureVercel),
    });
    expect(preparation.kind).toBe("approved");
    if (preparation.kind !== "approved") return;
    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: preparation.grant,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectId: "prj_target" });

    expect(prompt?.message).toBe(
      "Allow Development from inbound to access Production deployments of inbound?",
    );
    expect(prompt?.notices).toEqual([
      {
        tone: "warning",
        text: "This changes Deployment Protection for inbound until the Trusted Sources rule is removed.",
      },
    ]);
    expect(captureVercel).toHaveBeenNthCalledWith(
      1,
      ["api", "/v13/deployments/inbound.example.com", "--scope", "team_a", "--raw"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(captureVercel).toHaveBeenNthCalledWith(
      4,
      [
        "api",
        "/v9/projects/prj_target",
        "--scope",
        "team_a",
        "--method",
        "PATCH",
        "--input",
        "-",
        "--raw",
      ],
      expect.objectContaining({
        cwd: "/repo",
        stdin: JSON.stringify({
          trustedSources: {
            projects: {
              prj_target: {
                customAllow: [
                  rule("production", "production"),
                  rule("preview", "preview"),
                  rule("development", "preview"),
                  rule("development", "production"),
                ],
              },
            },
          },
        }),
      }),
    );
  });

  it("does not prompt or mutate for same-project development-to-preview", async () => {
    const captureVercel = captureSequence(
      success({ projectId: "prj_target", name: "inbound", target: null }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: null,
      }),
    );
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "unchanged" });

    expect(captureVercel).toHaveBeenCalledTimes(2);
  });

  it("preserves matching-environment defaults when adding another same-team project", async () => {
    const captureVercel = captureSequence(
      success({ projectId: "prj_target", name: "api", target: null }),
      success({
        id: "prj_target",
        name: "api",
        customEnvironments: [{ slug: "staging" }],
        trustedSources: null,
      }),
      success({
        id: "prj_source",
        name: "web",
        customEnvironments: [{ slug: "staging" }, { slug: "qa" }],
        trustedSources: null,
      }),
      success({
        id: "prj_target",
        name: "api",
        customEnvironments: [{ slug: "staging" }],
        trustedSources: null,
      }),
      success({
        id: "prj_source",
        name: "web",
        customEnvironments: [{ slug: "staging" }, { slug: "qa" }],
        trustedSources: null,
      }),
      success({ id: "prj_target" }),
    );
    const { prompter } = createFakePrompter({ single: () => "continue" });

    const preparation = await prepareVercelTrustedSourceAccess({
      workspaceRoot: "/repo",
      host: "api.example.com",
      prompter,
      deps: accessDeps(captureVercel, "prj_source"),
    });
    expect(preparation.kind).toBe("approved");
    if (preparation.kind !== "approved") return;
    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: preparation.grant,
        deps: accessDeps(captureVercel, "prj_source"),
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectId: "prj_target" });

    expect(captureVercel).toHaveBeenNthCalledWith(
      6,
      expect.any(Array),
      expect.objectContaining({
        stdin: JSON.stringify({
          trustedSources: {
            projects: {
              prj_source: {
                customAllow: [
                  rule("production", "production"),
                  rule("preview", "preview"),
                  rule("staging", "staging"),
                  rule("development", "preview"),
                ],
              },
            },
          },
        }),
      }),
    );
  });

  it("leaves policy unchanged when the user declines the access grant", async () => {
    const captureVercel = captureSequence(
      success({ projectId: "prj_target", name: "inbound", target: "production" }),
      success({
        id: "prj_target",
        name: "inbound",
        customEnvironments: [],
        trustedSources: null,
      }),
    );
    const { prompter } = createFakePrompter({ single: () => "cancel" });

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(captureVercel).toHaveBeenCalledTimes(2);
  });

  it("does not block non-Vercel remotes when the host cannot be resolved", async () => {
    const captureVercel = captureSequence(
      failure(
        "Deployment not found.",
        JSON.stringify({ error: { code: "not_found", message: "Deployment not found." } }),
      ),
    );
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        host: "custom.example.com",
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "not-applicable" });
  });

  it("does not collapse an operational deployment lookup failure into not-applicable", async () => {
    const captureVercel = captureSequence(failure("Vercel deployment lookup timed out."));
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        host: "inbound.example.com",
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message:
        "Could not resolve the Vercel deployment for inbound.example.com: Vercel deployment lookup timed out.",
    });
  });
});
