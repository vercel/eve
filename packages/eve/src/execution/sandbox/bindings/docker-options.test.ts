import { describe, expect, it } from "vitest";

import {
  createDockerSandboxOptionsHash,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  resolveDockerSandboxOptions,
} from "#execution/sandbox/bindings/docker-options.js";

describe("resolveDockerSandboxOptions", () => {
  it("defaults to eve's published sandbox runtime image with permissive networking", () => {
    expect(resolveDockerSandboxOptions()).toEqual({
      env: {},
      image: DEFAULT_DOCKER_SANDBOX_IMAGE,
      networkPolicy: "allow-all",
      ports: [],
      pullPolicy: "if-not-present",
    });
  });

  it("honors explicit options", () => {
    expect(
      resolveDockerSandboxOptions({
        env: { FOO: "bar" },
        image: "ubuntu:26.04",
        networkPolicy: "allow-all",
        ports: [{ hostPort: 43_000, sandboxPort: 3000 }],
        pullPolicy: "never",
      }),
    ).toEqual({
      env: { FOO: "bar" },
      image: "ubuntu:26.04",
      networkPolicy: "allow-all",
      ports: [{ hostPort: 43_000, sandboxPort: 3000 }],
      pullPolicy: "never",
    });
  });

  it("rejects published ports with deny-all networking", () => {
    expect(() =>
      resolveDockerSandboxOptions({
        networkPolicy: "deny-all",
        ports: [{ hostPort: 43_000, sandboxPort: 3000 }],
      }),
    ).toThrow('Docker sandbox ports require networkPolicy: "allow-all"');
  });

  it("hashes template-affecting options stably", () => {
    const first = createDockerSandboxOptionsHash(
      resolveDockerSandboxOptions({
        env: { B: "2", A: "1" },
        image: "ubuntu:26.04",
        networkPolicy: "allow-all",
      }),
    );
    const second = createDockerSandboxOptionsHash(
      resolveDockerSandboxOptions({
        env: { A: "1", B: "2" },
        image: "ubuntu:26.04",
        networkPolicy: "allow-all",
      }),
    );
    const changed = createDockerSandboxOptionsHash(
      resolveDockerSandboxOptions({
        env: { A: "changed", B: "2" },
        image: "ubuntu:26.04",
        networkPolicy: "allow-all",
      }),
    );

    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(
      createDockerSandboxOptionsHash(
        resolveDockerSandboxOptions({
          env: { A: "1", B: "2" },
          image: "ubuntu:26.04",
          networkPolicy: "allow-all",
          ports: [{ hostPort: 43_000, sandboxPort: 3000 }],
        }),
      ),
    ).not.toBe(first);
  });
});
