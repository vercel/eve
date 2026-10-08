import { access, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOciCommandRunner,
  createOciImagePublisher,
  type OciCommandRunner,
} from "#execution/sandbox/bindings/oci-image-publisher.js";
import { formatError } from "#internal/logging.js";

const digest = `sha256:${"a".repeat(64)}`;
const dockerfile = {
  contentHash: "context-hash",
  contextPath: "/app/agent/sandbox",
  path: "/app/agent/sandbox/Dockerfile",
};

afterEach(() => vi.unstubAllEnvs());

describe("createOciImagePublisher", () => {
  it("builds, authenticates, and publishes with Docker without exposing the token on argv", async () => {
    const calls: Array<{
      args: readonly string[];
      command: string;
      env: Readonly<Record<string, string>> | undefined;
      stdin: string | undefined;
    }> = [];
    const runner: OciCommandRunner = {
      async run(command, args, options) {
        calls.push({ args, command, env: options?.env, stdin: options?.stdin });
        return command === "docker" && args[0] === "push"
          ? { stderr: "", stdout: `published ${digest}` }
          : { stderr: "", stdout: "" };
      },
    };
    const publisher = createOciImagePublisher({
      authToken: "secret-token",
      engine: "docker",
      registry: "registry.example.com",
      runner,
      username: "account",
    });

    await expect(
      publisher.publish({
        dockerfile,
        imageReference: "registry.example.com/team/project/eve-sandbox:generation",
      }),
    ).resolves.toBe(`registry.example.com/team/project/eve-sandbox@${digest}`);

    expect(calls.map(({ args, command }) => [command, ...args])).toEqual([
      ["docker", "login", "registry.example.com", "--username", "account", "--password-stdin"],
      [
        "docker",
        "build",
        "--platform",
        "linux/amd64",
        "--tag",
        "registry.example.com/team/project/eve-sandbox:generation",
        "--file",
        dockerfile.path,
        dockerfile.contextPath,
      ],
      ["docker", "push", "registry.example.com/team/project/eve-sandbox:generation"],
    ]);
    expect(calls[0]?.stdin).toBe("secret-token");
    expect(calls.flatMap((call) => call.args)).not.toContain("secret-token");
    const dockerConfig = calls[0]?.env?.DOCKER_CONFIG;
    expect(dockerConfig).toBeTruthy();
    expect(calls.every((call) => call.env?.DOCKER_CONFIG === dockerConfig)).toBe(true);
    await expect(access(dockerConfig!)).rejects.toThrow();
  });

  it("uses an isolated Buildah auth file and returns its digest", async () => {
    vi.stubEnv("REGISTRY_AUTH_FILE", "/inherited/auth.json");
    const calls: Array<{
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>> | undefined;
    }> = [];
    const runner: OciCommandRunner = {
      async run(_command, args, options) {
        calls.push({ args, env: options?.env });
        const digestFlag = args.indexOf("--digestfile");
        if (digestFlag !== -1) await writeFile(args[digestFlag + 1]!, digest);
        return { stderr: "", stdout: "" };
      },
    };
    const publisher = createOciImagePublisher({
      authToken: "secret-token",
      engine: "buildah",
      registry: "registry.example.com",
      runner,
      username: "account",
    });

    await expect(
      publisher.publish({ dockerfile, imageReference: "registry.example.com/image:latest" }),
    ).resolves.toBe(`registry.example.com/image@${digest}`);
    expect(calls.some(({ args }) => args[0] === "login")).toBe(true);
    expect(calls.map(({ args }) => args)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["--registries-conf", "build", "--layers", "--network", "host"]),
        expect.arrayContaining(["push", "--digestfile"]),
      ]),
    );
    const authFile = calls[0]?.env?.REGISTRY_AUTH_FILE;
    expect(authFile).toBeTruthy();
    expect(authFile).not.toBe("/inherited/auth.json");
    expect(calls.every((call) => call.env?.REGISTRY_AUTH_FILE === authFile)).toBe(true);
    await expect(access(authFile!)).rejects.toThrow();
  });

  it("redacts credentials from authentication failures", async () => {
    const runner: OciCommandRunner = {
      async run(_command, args) {
        if (args[0] === "login") throw new Error("rejected secret-token");
        return { stderr: "", stdout: "" };
      },
    };
    const publisher = createOciImagePublisher({
      authToken: "secret-token",
      engine: "docker",
      registry: "registry.example.com",
      runner,
      username: "account",
    });

    const error = await publisher
      .publish({ dockerfile, imageReference: "registry.example.com/image:latest" })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("rejected [redacted]");
    expect(JSON.stringify(formatError(error))).not.toContain("secret-token");
  });

  it("retains only a bounded tail of child-process output", async () => {
    const result = await createOciCommandRunner().run(process.execPath, [
      "-e",
      'process.stdout.write("a".repeat(300000)); process.stderr.write("b".repeat(300000));',
    ]);

    expect(Buffer.byteLength(result.stdout)).toBe(256 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBe(256 * 1024);
  });

  it("fails when the registry does not return a content digest", async () => {
    const runner: OciCommandRunner = {
      async run(_command, args) {
        return args[0] === "inspect"
          ? { stderr: "", stdout: "registry.example.com/image:latest" }
          : { stderr: "", stdout: "" };
      },
    };
    const publisher = createOciImagePublisher({
      authToken: "secret-token",
      engine: "docker",
      registry: "registry.example.com",
      runner,
      username: "account",
    });

    await expect(
      publisher.publish({ dockerfile, imageReference: "registry.example.com/image:latest" }),
    ).rejects.toThrow("did not return a digest");
  });
});
