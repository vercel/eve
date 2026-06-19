import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import type { VercelCaptureResult } from "#setup/primitives/index.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
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

const PREVIEW_TARGET = await resolveTestVercelTarget({
  host: "inbound.example.com",
  projectId: "prj_target",
  projectName: "inbound",
});
const PRODUCTION_TARGET = await resolveTestVercelTarget({
  host: "inbound.example.com",
  projectId: "prj_target",
  projectName: "inbound",
  environment: "production",
});

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

function projectResponse(
  id: string,
  name: string,
  customEnvironmentSlugs: readonly string[] = [],
  trustedSources: unknown = null,
) {
  return {
    id,
    name,
    customEnvironments: customEnvironmentSlugs.map((slug) => ({ slug })),
    trustedSources,
  };
}

function failure(message: string): VercelCaptureResult {
  return { ok: false, failure: { code: 1, message, stderr: "", stdout: "" } };
}

function accessDeps(
  captureVercel: VercelTrustedSourceDeps["captureVercel"],
): Partial<VercelTrustedSourceDeps> {
  return { captureVercel };
}

async function prepareAndApply(input: {
  readonly captureVercel: VercelTrustedSourceDeps["captureVercel"];
  readonly prompter: Prompter;
  readonly sourceProject?: { readonly projectId: string; readonly scope: string };
  readonly target?: typeof PRODUCTION_TARGET;
}) {
  const preparation = await prepareVercelTrustedSourceAccess({
    workspaceRoot: "/repo",
    sourceProject: input.sourceProject ?? { projectId: "prj_target", scope: "team_a" },
    target: input.target ?? PRODUCTION_TARGET,
    prompter: input.prompter,
    deps: accessDeps(input.captureVercel),
  });
  if (preparation.kind !== "approved") {
    throw new Error(`Expected approved access, received ${preparation.kind}.`);
  }
  return await applyVercelTrustedSourceAccess({
    workspaceRoot: "/repo",
    grant: preparation.grant,
    deps: accessDeps(input.captureVercel),
  });
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
  it("returns the PATCH failure without claiming the policy changed", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "inbound")),
      failure("Vercel rejected the policy update."),
    );

    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: {
          scope: "team_a",
          sourceProjectId: "prj_target",
          sourceEnvironment: "development",
          targetProjectId: "prj_target",
          targetProjectName: "inbound",
          targetEnvironment: "production",
        },
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message: "Could not update Trusted Sources for inbound: Vercel rejected the policy update.",
    });
  });

  it("re-reads the target policy immediately before patching", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "inbound")),
      success(
        projectResponse("prj_target", "inbound", [], {
          projects: { prj_other: { label: "concurrent rule" } },
        }),
      ),
      success({ id: "prj_target" }),
    );
    const { prompter } = createFakePrompter({ single: () => "continue" });

    await expect(
      prepareAndApply({
        captureVercel,
        prompter,
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectId: "prj_target" });

    expect(captureVercel).toHaveBeenCalledTimes(3);
    expect(captureVercel).toHaveBeenNthCalledWith(
      3,
      expect.any(Array),
      expect.objectContaining({
        stdin: expect.stringContaining('"prj_other":{"label":"concurrent rule"}'),
      }),
    );
  });

  it("warns before granting the resolved development-to-production pair", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "inbound")),
      success(projectResponse("prj_target", "inbound")),
      success({ id: "prj_target" }),
    );
    let prompt: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createFakePrompter({
      single: (options) => {
        prompt = options;
        return "continue";
      },
    });

    await expect(prepareAndApply({ captureVercel, prompter })).resolves.toMatchObject({
      kind: "updated",
      targetProjectId: "prj_target",
    });

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
      3,
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
    const captureVercel = captureSequence(success(projectResponse("prj_target", "inbound")));
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        sourceProject: { projectId: "prj_target", scope: "team_a" },
        target: PREVIEW_TARGET,
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "unchanged" });

    expect(captureVercel).toHaveBeenCalledTimes(1);
  });

  it("preserves matching-environment defaults when adding another same-team project", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "api", ["staging"])),
      success(projectResponse("prj_source", "web", ["staging", "qa"])),
      success(projectResponse("prj_target", "api", ["staging"])),
      success(projectResponse("prj_source", "web", ["staging", "qa"])),
      success({ id: "prj_target" }),
    );
    const { prompter } = createFakePrompter({ single: () => "continue" });

    await expect(
      prepareAndApply({
        captureVercel,
        prompter,
        sourceProject: { projectId: "prj_source", scope: "team_a" },
        target: PREVIEW_TARGET,
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectId: "prj_target" });

    expect(captureVercel).toHaveBeenNthCalledWith(
      5,
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
    const captureVercel = captureSequence(success(projectResponse("prj_target", "inbound")));
    const { prompter } = createFakePrompter({ single: () => "cancel" });

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        sourceProject: { projectId: "prj_target", scope: "team_a" },
        target: PRODUCTION_TARGET,
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(captureVercel).toHaveBeenCalledTimes(1);
  });
});
