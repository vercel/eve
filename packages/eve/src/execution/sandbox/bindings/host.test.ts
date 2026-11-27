import { describe, expect, it } from "vitest";

import {
  assertPosixHost,
  createHostSandboxProvider,
  HOST_PROVIDER_NAME,
  isDefaultStrippedHostEnv,
  resolveHostEnvironment,
} from "#execution/sandbox/bindings/host.js";
import { createSandboxPrepareContext } from "#execution/sandbox/prewarm.js";
import { createSandboxProviderFiles } from "#execution/sandbox/provider-files.js";
import type { SandboxProviderResourceFile } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

function prepareContext(input: {
  readonly prepare?: (sandbox: SandboxSession) => void | Promise<void>;
  readonly skills?: readonly SandboxProviderResourceFile[];
  readonly workspace?: readonly SandboxProviderResourceFile[];
}) {
  const hasFiles = (input.skills?.length ?? 0) + (input.workspace?.length ?? 0) > 0;
  return createSandboxPrepareContext({
    appRoot: "/app",
    files: createSandboxProviderFiles("/app/agent/sandbox"),
    log: () => {},
    provider: {
      prepare: input.prepare,
      providerName: HOST_PROVIDER_NAME,
    },
    resources: {
      key: hasFiles ? "res-key" : undefined,
      skills: input.skills,
      workspace: input.workspace,
    },
    sourceRevision: "rev-1",
    storagePath: "/app/.eve/sandbox",
  });
}

describe("HostSandbox environment and preparation", () => {
  it("strips default eve, Nitro, and model-provider server variables while preserving host toolchain env", () => {
    const resolved = resolveHostEnvironment({
      baseEnv: {
        AI_GATEWAY_API_KEY: "secret-gw",
        ANTHROPIC_API_KEY: "secret-anth",
        CONDA_PREFIX: "/opt/conda/envs/testbed",
        EVE_DEV: "1",
        EVE_DEVELOPMENT_RUN_ID: "run-123",
        GOOGLE_GENERATIVE_AI_API_KEY: "secret-google",
        HOME: "/home/alice",
        NITRO_HOST: "127.0.0.1",
        NITRO_PORT: "3024",
        OPENAI_API_KEY: "secret-oai",
        PATH: "/opt/conda/envs/testbed/bin:/usr/bin",
        VERCEL_OIDC_TOKEN: "secret-oidc",
      },
      inheritEnv: true,
      skillsDir: "/app/.eve/sandbox/host/sessions/abc/skills",
    });

    expect(resolved).toEqual({
      AI_AGENT: "eve",
      CONDA_PREFIX: "/opt/conda/envs/testbed",
      EVE_SKILLS_DIR: "/app/.eve/sandbox/host/sessions/abc/skills",
      HOME: "/home/alice",
      PATH: "/opt/conda/envs/testbed/bin:/usr/bin",
    });
    expect(isDefaultStrippedHostEnv("EVE_DEVELOPMENT_LINUX_DOCKER_AVAILABLE")).toBe(true);
    expect(isDefaultStrippedHostEnv("PATH")).toBe(false);
  });

  it("applies env precedence (base -> defaults -> environment -> open -> call) and supports undefined unsets", () => {
    const resolved = resolveHostEnvironment({
      baseEnv: {
        HOST_KEEP: "base",
        HOST_UNSET: "remove-me",
        NODE_ENV: "production",
        OPENAI_API_KEY: "base-key",
      },
      callEnv: {
        LAYERED: "call",
      },
      environmentEnv: {
        AI_AGENT: "custom-agent",
        HOST_UNSET: undefined,
        LAYERED: "env",
        OPENAI_API_KEY: "explicit-key",
      },
      inheritEnv: true,
      runtimeEnv: {
        LAYERED: "runtime",
        NODE_ENV: undefined,
        SESSION_VAR: "ok",
      },
      skillsDir: "/tmp/eve-skills",
    });

    expect(resolved).toEqual({
      AI_AGENT: "custom-agent",
      EVE_SKILLS_DIR: "/tmp/eve-skills",
      HOST_KEEP: "base",
      LAYERED: "call",
      OPENAI_API_KEY: "explicit-key",
      SESSION_VAR: "ok",
    });
  });

  it("starts from a minimal env when inheritEnv is false", () => {
    const resolved = resolveHostEnvironment({
      baseEnv: {
        HOME: "/home/alice",
        NODE_ENV: "production",
        PATH: "/usr/bin",
      },
      inheritEnv: false,
      runtimeEnv: {
        PATH: "/custom/bin",
      },
      skillsDir: "/tmp/eve-skills",
    });

    expect(resolved).toEqual({
      AI_AGENT: "eve",
      EVE_SKILLS_DIR: "/tmp/eve-skills",
      PATH: "/custom/bin",
    });
  });

  it("rejects Windows hosts with actionable guidance and accepts POSIX platforms", () => {
    expect(() => assertPosixHost("win32")).toThrow(/POSIX host \(Linux or macOS\)/u);
    expect(() => assertPosixHost("linux")).not.toThrow();
    expect(() => assertPosixHost("darwin")).not.toThrow();
  });

  it("validates non-empty cwd and shell options", () => {
    expect(() => createHostSandboxProvider({ cwd: "   " })).toThrow(/`cwd`/u);
    expect(() => createHostSandboxProvider({ shell: "" })).toThrow(/`shell`/u);
  });

  it.skipIf(process.platform === "win32")(
    "captures skills in prepare() without touching disk and rejects workspace seeds and prepare scripts",
    async () => {
      const provider = createHostSandboxProvider();

      await expect(provider.prepare(prepareContext({}))).resolves.toEqual({ version: 1 });

      const withSkills = await provider.prepare(
        prepareContext({
          skills: [
            { content: "# Investigate\n", relativePath: "investigate/SKILL.md" },
            { content: "echo hi\n", relativePath: "investigate/scripts/run.sh" },
          ],
        }),
      );
      expect(withSkills).toEqual({
        skills: [
          {
            contentBase64: Buffer.from("# Investigate\n").toString("base64"),
            path: "investigate/SKILL.md",
          },
          {
            contentBase64: Buffer.from("echo hi\n").toString("base64"),
            path: "investigate/scripts/run.sh",
          },
        ],
        version: 1,
      });

      await expect(
        provider.prepare(
          prepareContext({
            workspace: [{ content: "seed\n", relativePath: "README.md" }],
          }),
        ),
      ).rejects.toThrow(/does not seed `agent\/sandbox\/workspace\/`/u);

      await expect(
        provider.prepare(
          prepareContext({
            prepare: async (sandbox) => {
              await sandbox.run({ command: "echo hi" });
            },
          }),
        ),
      ).rejects.toThrow(/does not run build-time `prepare` scripts/u);
    },
  );
});
