import { describe, expect, it } from "vitest";

import { normalizeSandboxDefinition } from "../src/internal/authored-definition/sandbox.js";
import { docker } from "../src/public/sandbox/backends/docker.js";
import { vercel } from "../src/public/sandbox/backends/vercel.js";

const ERROR_MESSAGE = "Test error";

describe("normalizeSandboxDefinition", () => {
  it("accepts an empty definition", () => {
    expect(normalizeSandboxDefinition({}, ERROR_MESSAGE)).toEqual({});
  });

  it("accepts a definition that names a backend factory result", () => {
    const result = normalizeSandboxDefinition({ backend: docker() }, ERROR_MESSAGE);
    expect(result.backend?.name).toBe("docker");
  });

  it("accepts the vercel factory result", () => {
    const result = normalizeSandboxDefinition({ backend: vercel() }, ERROR_MESSAGE);
    expect(result.backend?.name).toBe("vercel");
  });

  it("accepts a custom inline backend", () => {
    const customBackend = {
      name: "custom",
      async create() {
        return {} as never;
      },
    };
    const result = normalizeSandboxDefinition({ backend: customBackend }, ERROR_MESSAGE);
    expect(result.backend?.name).toBe("custom");
  });

  it("accepts bootstrap, onSession, and description fields", () => {
    const bootstrap = async () => {};
    const onSession = async () => {};
    const result = normalizeSandboxDefinition(
      {
        backend: docker(),
        bootstrap,
        description: "A test sandbox.",
        onSession,
      },
      ERROR_MESSAGE,
    );
    expect(result.description).toBe("A test sandbox.");
    expect(result.bootstrap).toBe(bootstrap);
    expect(result.revalidationKey).toBeUndefined();
    expect(result.onSession).toBe(onSession);
  });

  it("accepts bootstrap with a revalidationKey", () => {
    const bootstrap = async () => {};
    const revalidationKey = () => "test-bootstrap";
    const result = normalizeSandboxDefinition(
      {
        bootstrap,
        revalidationKey,
      },
      ERROR_MESSAGE,
    );

    expect(result.bootstrap).toBe(bootstrap);
    expect(result.revalidationKey).toBe(revalidationKey);
  });

  it("rejects revalidationKey without bootstrap", () => {
    expect(() =>
      normalizeSandboxDefinition(
        {
          revalidationKey: () => "unused",
        },
        ERROR_MESSAGE,
      ),
    ).toThrow(/"revalidationKey" field can only be set/);
  });

  it("rejects non-function revalidationKey values", () => {
    expect(() =>
      normalizeSandboxDefinition(
        {
          bootstrap: async () => {},
          revalidationKey: "not a function",
        },
        ERROR_MESSAGE,
      ),
    ).toThrow(ERROR_MESSAGE);
  });

  it("rejects legacy cacheKey values", () => {
    expect(() =>
      normalizeSandboxDefinition(
        {
          bootstrap: async () => {},
          cacheKey: () => "unused",
        },
        ERROR_MESSAGE,
      ),
    ).toThrow(/Unknown key "cacheKey"/);
  });

  it("rejects a non-object backend value", () => {
    expect(() => normalizeSandboxDefinition({ backend: 5 }, ERROR_MESSAGE)).toThrow(
      /SandboxBackend value/,
    );
  });

  it("rejects a backend without a name", () => {
    expect(() =>
      normalizeSandboxDefinition({ backend: { create: async () => ({}) as never } }, ERROR_MESSAGE),
    ).toThrow(/non-empty string "name"/);
  });

  it("rejects a backend without a create function", () => {
    expect(() => normalizeSandboxDefinition({ backend: { name: "x" } }, ERROR_MESSAGE)).toThrow(
      /"create" function/,
    );
  });

  it("rejects a backend whose prewarm is not a function", () => {
    expect(() =>
      normalizeSandboxDefinition(
        {
          backend: {
            name: "x",
            create: async () => ({}) as never,
            prewarm: "not a function",
          },
        },
        ERROR_MESSAGE,
      ),
    ).toThrow(/"backend.prewarm"/);
  });

  it("rejects a definition with the now-removed `adapter` key", () => {
    expect(() => normalizeSandboxDefinition({ adapter: "vercel" }, ERROR_MESSAGE)).toThrow(
      ERROR_MESSAGE,
    );
  });

  it("rejects a non-string description", () => {
    expect(() => normalizeSandboxDefinition({ description: 5 }, ERROR_MESSAGE)).toThrow(
      /"description" field must be a string/,
    );
  });

  it("accepts a backend factory callback and invokes it lazily, once", () => {
    let calls = 0;
    const backend = {
      name: "lazy-test",
      async create() {
        return {} as never;
      },
      async prewarm() {
        return { reused: false };
      },
    };
    const result = normalizeSandboxDefinition(
      {
        backend: () => {
          calls += 1;
          return backend;
        },
      },
      ERROR_MESSAGE,
    );

    expect(calls).toBe(0); // not yet invoked at normalize time
    expect(result.backend?.name).toBe("lazy-test");
    expect(calls).toBe(1);
    // subsequent accesses reuse the cached value
    expect(result.backend?.name).toBe("lazy-test");
    expect(calls).toBe(1);
  });
});
