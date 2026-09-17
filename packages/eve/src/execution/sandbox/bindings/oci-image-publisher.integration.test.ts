import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOciImagePublisher,
  type OciCommandRunner,
} from "#execution/sandbox/bindings/oci-image-publisher.js";

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
      stdin: string | undefined;
    }> = [];
    const runner: OciCommandRunner = {
      async run(command, args, options) {
        calls.push({ args, command, stdin: options?.stdin });
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
  });

  it("uses buildah with a standard auth file and returns its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-oci-auth-test-"));
    const authFile = join(directory, "auth.json");
    await writeFile(authFile, "{}\n");
    vi.stubEnv("REGISTRY_AUTH_FILE", authFile);
    const calls: Array<readonly string[]> = [];
    const runner: OciCommandRunner = {
      async run(_command, args) {
        calls.push(args);
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

    try {
      await expect(
        publisher.publish({ dockerfile, imageReference: "registry.example.com/image:latest" }),
      ).resolves.toBe(`registry.example.com/image@${digest}`);
      expect(calls.some((args) => args[0] === "login")).toBe(false);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(["--registries-conf", "build", "--layers", "--network", "host"]),
          expect.arrayContaining(["push", "--digestfile"]),
        ]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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

    await expect(
      publisher.publish({ dockerfile, imageReference: "registry.example.com/image:latest" }),
    ).rejects.toThrow("rejected [redacted]");
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
