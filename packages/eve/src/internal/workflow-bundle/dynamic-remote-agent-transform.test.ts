import { beforeEach, describe, expect, it } from "vitest";

import { transformDynamicRemoteAgentCredentials } from "./dynamic-remote-agent-transform.js";

beforeEach(() => {
  const key = Symbol.for("@workflow/core//registeredSteps");
  const registry = (globalThis as Record<symbol, Map<string, Function> | undefined>)[key];
  registry?.clear();
});

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
    const result = await transformDynamicRemoteAgentCredentials("subagents/research.ts", source);
    if (result === null) throw new Error("Transform returned null");
    let code = result.code.replace(/import\s+[^;]+;/g, "");
    code = code.replace(/export\s+default\s+/g, "var __exported = ");
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
      `${code}\nreturn __exported;`,
    );
    evaluate(defineDynamic, defineRemoteAgent);
    if (handler === undefined) throw new Error("No handler captured");

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

  it("does not transform public remote definitions without credentials", async () => {
    await expect(
      transformDynamicRemoteAgentCredentials(
        "subagents/research.ts",
        `export default defineDynamic({ events: { "session.started": () => defineRemoteAgent({ description: "Research", url: "https://example.com" }) } });`,
      ),
    ).resolves.toBeNull();
  });
});
