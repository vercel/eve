import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import type { VercelCaptureResult } from "#setup/primitives/index.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
import { trustedSourcesToJSON } from "@vercel/sdk/models/updateprojectprojectsoptionsallowlist.js";
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
  readonly target?: typeof PRODUCTION_TARGET;
}) {
  const preparation = await prepareVercelTrustedSourceAccess({
    workspaceRoot: "/repo",
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
        project: self,
        targetEnvironment: "preview",
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("preserves self-access defaults when adding development-to-production", () => {
    expect(
      planTrustedSourceAccess({
        project: self,
        targetEnvironment: "production",
        trustedSources: {
          projects: {
            prj_other: { label: "existing project" },
          },
          oidcProviders: {
            "https://token.actions.githubusercontent.com": [
              {
                to: { slugs: ["production"] },
                claims: { repository: ["acme/app"] },
              },
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
          "https://token.actions.githubusercontent.com": [
            {
              to: { slugs: ["production"] },
              claims: { repository: ["acme/app"] },
            },
          ],
        },
      },
    });
  });

  it("appends to explicit rules without restoring defaults the user removed", () => {
    expect(
      planTrustedSourceAccess({
        project: self,
        targetEnvironment: "production",
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

  it("preserves custom-environment defaults before adding development access", () => {
    expect(
      planTrustedSourceAccess({
        project: {
          projectId: "prj_target",
          customEnvironmentSlugs: ["staging"],
        },
        targetEnvironment: "staging",
      }),
    ).toEqual({
      kind: "update",
      trustedSources: {
        projects: {
          prj_target: {
            customAllow: [
              rule("production", "production"),
              rule("preview", "preview"),
              rule("development", "preview"),
              rule("staging", "staging"),
              rule("development", "staging"),
            ],
          },
        },
      },
    });
  });

  it("is idempotent when an existing rule already covers the pair", () => {
    expect(
      planTrustedSourceAccess({
        project: self,
        targetEnvironment: "production",
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
          ownerId: "team_a",
          projectId: "prj_target",
          projectName: "inbound",
          targetEnvironment: "production",
        },
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message: "Could not update Trusted Sources for inbound: Vercel rejected the policy update.",
    });
  });

  it("rejects a structured PATCH error even when the Vercel CLI exits zero", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "inbound")),
      success({ error: { code: "forbidden", message: "Team access denied" } }),
    );

    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: {
          ownerId: "team_a",
          projectId: "prj_target",
          projectName: "inbound",
          targetEnvironment: "production",
        },
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message:
        "Could not update Trusted Sources for inbound: Vercel API request failed: Team access denied.",
    });
  });

  it("rejects a PATCH response for a different project", async () => {
    const captureVercel = captureSequence(
      success(projectResponse("prj_target", "inbound")),
      success({ id: "prj_other" }),
    );

    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: {
          ownerId: "team_a",
          projectId: "prj_target",
          projectName: "inbound",
          targetEnvironment: "production",
        },
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message: "Vercel returned an invalid project response.",
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
    ).resolves.toMatchObject({ kind: "updated", targetProjectName: "inbound" });

    expect(captureVercel).toHaveBeenCalledTimes(3);
    expect(captureVercel).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining([
        "--field",
        expect.stringContaining('"prj_other":{"label":"concurrent rule"}'),
      ]),
      expect.any(Object),
    );
  });

  it("serializes Trusted Sources through the SDK contract", async () => {
    const captureVercel = captureSequence(
      success(
        projectResponse("prj_target", "inbound", [], {
          projects: {
            prj_other: {
              label: "existing policy",
              futureProjectField: "discard",
            },
          },
          futureTopLevelField: "discard",
        }),
      ),
      success({ id: "prj_target" }),
    );

    await expect(
      applyVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        grant: {
          ownerId: "team_test",
          projectId: "prj_target",
          projectName: "inbound",
          targetEnvironment: "production",
        },
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toMatchObject({ kind: "updated", targetProjectName: "inbound" });

    expect(captureVercel).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        "--field",
        `trustedSources=${trustedSourcesToJSON({
          projects: {
            prj_other: { label: "existing policy" },
            prj_target: {
              customAllow: [
                rule("production", "production"),
                rule("preview", "preview"),
                rule("development", "preview"),
                rule("development", "production"),
              ],
            },
          },
        })}`,
      ]),
      expect.any(Object),
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
      targetProjectName: "inbound",
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
        "team_test",
        "--method",
        "PATCH",
        "--field",
        `trustedSources=${trustedSourcesToJSON({
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
        })}`,
        "--raw",
      ],
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
  });

  it("does not prompt or mutate for same-project development-to-preview", async () => {
    const captureVercel = captureSequence(success(projectResponse("prj_target", "inbound")));
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        target: PREVIEW_TARGET,
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "unchanged" });

    expect(captureVercel).toHaveBeenCalledTimes(1);
  });

  it("rejects a project response for a different project", async () => {
    const captureVercel = captureSequence(success(projectResponse("prj_other", "other-project")));
    const { prompter } = createFakePrompter();

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        target: PRODUCTION_TARGET,
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({
      kind: "failed",
      message:
        "Could not read Deployment Protection for inbound: Vercel returned an invalid project response.",
    });
    expect(captureVercel).toHaveBeenCalledTimes(1);
  });

  it("leaves policy unchanged when the user declines the access grant", async () => {
    const captureVercel = captureSequence(success(projectResponse("prj_target", "inbound")));
    const { prompter } = createFakePrompter({ single: () => "cancel" });

    await expect(
      prepareVercelTrustedSourceAccess({
        workspaceRoot: "/repo",
        target: PRODUCTION_TARGET,
        prompter,
        deps: accessDeps(captureVercel),
      }),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(captureVercel).toHaveBeenCalledTimes(1);
  });
});
