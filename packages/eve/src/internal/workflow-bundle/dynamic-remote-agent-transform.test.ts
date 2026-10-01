import { beforeEach, describe, expect, it } from "vitest";

import { transformDynamicRemoteAgentCredentials } from "./dynamic-remote-agent-transform.js";

beforeEach(() => {
  const key = Symbol.for("@workflow/core//registeredSteps");
  const registry = (globalThis as Record<symbol, Map<string, Function> | undefined>)[key];
  registry?.clear();
});

async function transformSource(source: string): Promise<string> {
  const result = await transformDynamicRemoteAgentCredentials("subagents/research.ts", source);
  if (result === null) throw new Error("Transform returned null");
  return result.code;
}

function evaluateSessionHandler(code: string): Function {
  const executable = code
    .replace(/import\s+[^;]+;/g, "")
    .replace(/export\s+default\s+/g, "var __exported = ");
  let handler: Function | undefined;
  const defineDynamic = (definition: { events: Record<string, Function> }) => {
    handler = definition.events["session.started"];
    return definition;
  };
  const defineRemoteAgent = (definition: Record<string, unknown>) => ({
    ...definition,
    kind: "remote",
    path: "/eve/v1/session",
  });
  const evaluate = new Function(
    "defineDynamic",
    "defineRemoteAgent",
    `${executable}\nreturn __exported;`,
  );
  evaluate(defineDynamic, defineRemoteAgent);
  if (handler === undefined) throw new Error("No handler captured");
  return handler;
}

describe("transformDynamicRemoteAgentCredentials", () => {
  it("registers remote auth and headers without making them enumerable", async () => {
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

function createAuth() {
  return async () => ({ headers: { authorization: "Bearer fresh" } });
}

export default defineDynamic({
  events: {
    "session.started": () =>
      defineRemoteAgent({
        auth: createAuth(),
        description: "Remote research.",
        headers: () => ({ "x-runtime": "fresh" }),
        url: "https://research.example.com",
      }),
  },
});
`;
    const handler = evaluateSessionHandler(await transformSource(source));
    const remote = handler() as Record<string, unknown>;
    const credentialsFactory = remote.__eveResolveRemoteAgentCredentials as {
      stepId?: string;
    };
    expect(Object.keys(remote)).not.toContain("__eveResolveRemoteAgentCredentials");
    expect(credentialsFactory.stepId).toMatch(/^eve:dynamic-remote-agent\/\//);
    const key = Symbol.for("@workflow/core//registeredSteps");
    const registry = (globalThis as Record<symbol, Map<string, Function> | undefined>)[key];
    if (registry === undefined) throw new Error("Step registry was not created");
    const registered = registry.get(credentialsFactory.stepId!);
    expect(registered).toBeDefined();
    const credentials = registered!() as Record<string, Function>;
    await expect(credentials.auth!()).resolves.toEqual({
      headers: { authorization: "Bearer fresh" },
    });
    expect(await credentials.headers!()).toEqual({ "x-runtime": "fresh" });
  });

  it("transforms remote definitions inside conditional expressions", async () => {
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

const enabled = true;
export default defineDynamic({
  events: {
    "session.started": () =>
      enabled
        ? defineRemoteAgent({
            description: "Remote research.",
            headers: () => ({ "x-runtime": "fresh" }),
            url: "https://research.example.com",
          })
        : null,
  },
});
`;
    const handler = evaluateSessionHandler(await transformSource(source));
    const remote = handler() as Record<string, unknown>;

    expect(remote.__eveResolveRemoteAgentCredentials).toBeTypeOf("function");
  });

  it("preserves quoted credential keys and method shorthand", async () => {
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineRemoteAgent({
        "auth": async () => ({ headers: { authorization: "Bearer fresh" } }),
        description: "Remote research.",
        headers() {
          return { "x-runtime": "fresh" };
        },
        url: "https://research.example.com",
      }),
  },
});
`;
    const handler = evaluateSessionHandler(await transformSource(source));
    const remote = handler() as Record<string, unknown>;
    const credentialsFactory = remote.__eveResolveRemoteAgentCredentials as Function;
    const credentials = credentialsFactory() as Record<string, Function>;

    await expect(credentials.auth!()).resolves.toEqual({
      headers: { authorization: "Bearer fresh" },
    });
    expect(credentials.headers!()).toEqual({ "x-runtime": "fresh" });
  });

  it("hoists credentials from aliased and namespace imports", async () => {
    for (const source of [
      `import { defineDynamic, defineRemoteAgent as remote } from "eve";
export default defineDynamic({ events: { "session.started": () => remote({ description: "Research", url: "https://example.com", headers: () => ({ "x-runtime": "fresh" }) }) } });`,
      `import * as eve from "eve";
export default eve.defineDynamic({ events: { "session.started": () => eve.defineRemoteAgent({ description: "Research", url: "https://example.com", headers: () => ({ "x-runtime": "fresh" }) }) } });`,
    ]) {
      expect(await transformSource(source)).toContain("__eveResolveRemoteAgentCredentials");
    }
  });

  it("fails the build when credentials reference a function-local binding", async () => {
    // The hoisted copy would silently read the module-level "env" instead.
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

const env = "STAGING";
export default defineDynamic({
  events: {
    "session.started": () => {
      const env = "PRODUCTION";
      return defineRemoteAgent({
        description: "Remote research.",
        headers: () => ({ "x-env": env }),
        url: "https://research.example.com",
      });
    },
  },
});
`;
    await expect(transformSource(source)).rejects.toThrow(
      /Dynamic remote agent "headers" in subagents\/research\.ts references "env", declared inside a function/,
    );
  });

  it("allows credentials that use module bindings and their own locals", async () => {
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

const ENV = "PRODUCTION";
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineRemoteAgent({
        async auth(request) {
          const ctx = { token: ENV };
          return { headers: { authorization: ctx.token, url: request?.url } };
        },
        description: "Remote research.",
        url: "https://research.example.com",
      }),
  },
});
`;
    expect(await transformSource(source)).toContain("__eveResolveRemoteAgentCredentials");
  });

  it("does not transform public remote definitions without credentials", async () => {
    await expect(
      transformDynamicRemoteAgentCredentials(
        "subagents/research.ts",
        `export default defineDynamic({ events: { "session.started": () => defineRemoteAgent({ description: "Research", url: "https://example.com" }) } });`,
      ),
    ).resolves.toBeNull();
  });

  it("shares one hoisted declaration across byte-identical credential factories", async () => {
    const factoryCall = `defineRemoteAgent({
          auth: async () => ({ headers: { authorization: "Bearer fresh" } }),
          description: "Remote research.",
          url: "https://research.example.com",
        })`;
    const source = `
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic({
  events: {
    "session.started": () => ({
      researcher: ${factoryCall},
      writer: ${factoryCall},
    }),
  },
});
`;
    const code = await transformSource(source);

    const declarations = [...code.matchAll(/function (__eve_dynamic_remote_credentials_\w+)\(/g)];
    expect(declarations).toHaveLength(1);

    // Both call sites must reference the shared hoisted implementation.
    const name = declarations[0]![1]!;
    expect(code.split(name).length - 1).toBeGreaterThanOrEqual(3);
  });
});
