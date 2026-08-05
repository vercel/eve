import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { provisionResendConnector, type ResendConnectDeps } from "./connect.js";

function deps(list: unknown): ResendConnectDeps {
  return {
    captureVercel: vi.fn<ResendConnectDeps["captureVercel"]>(async () => ({
      ok: true,
      stdout: JSON.stringify(list),
    })),
    runVercel: vi.fn(async () => true),
    runVercelCaptureStdout: vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        id: "scl_resend",
        uid: "api-key/resend-agent",
        type: "api-key",
        service: "api.resend.com",
        supportedSubjectTypes: ["app"],
      }),
    })),
  };
}

function input(effects: ResendConnectDeps) {
  return {
    apiKey: "re_secret",
    log: createFakePrompter().prompter.log,
    project: { orgId: "team", projectId: "project" },
    projectRoot: "/project",
    slug: "resend-agent",
    deps: effects,
  };
}

describe("Resend Connect provisioning", () => {
  it("creates with stdin secrets and attaches without triggers", async () => {
    const effects = deps({ connectors: [] });
    await provisionResendConnector(input(effects));

    expect(effects.runVercelCaptureStdout).toHaveBeenCalledWith(
      expect.arrayContaining(["--data", "@-", "--name", "resend-agent"]),
      expect.objectContaining({
        stdin: JSON.stringify({ values: [{ value: "re_secret" }] }),
      }),
    );
    const argv = vi.mocked(effects.runVercelCaptureStdout).mock.calls[0]?.[0] ?? [];
    expect(argv.join(" ")).not.toContain("re_secret");
    expect(effects.runVercel).toHaveBeenCalledWith(
      expect.not.arrayContaining(["--triggers"]),
      expect.anything(),
    );
  });

  it("reuses the deterministic compatible connector", async () => {
    const effects = deps({
      connectors: [
        {
          id: "scl_resend",
          uid: "api-key/resend-agent",
          type: "api-key",
          service: "api.resend.com",
          supportedSubjectTypes: ["app"],
        },
      ],
    });
    await expect(provisionResendConnector(input(effects))).resolves.toEqual({
      id: "scl_resend",
      uid: "api-key/resend-agent",
    });
    expect(effects.runVercelCaptureStdout).not.toHaveBeenCalled();
  });

  it("rejects an incompatible deterministic UID", async () => {
    const effects = deps({
      connectors: [
        {
          id: "scl_other",
          uid: "api-key/resend-agent",
          type: "oauth",
          service: "other.example",
        },
      ],
    });
    await expect(provisionResendConnector(input(effects))).rejects.toThrow("not an API-key");
  });
});
