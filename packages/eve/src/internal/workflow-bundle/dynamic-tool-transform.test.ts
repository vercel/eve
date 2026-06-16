import { describe, expect, it, beforeEach } from "vitest";

import { transformDynamicToolExecute } from "./dynamic-tool-transform.js";

// ---------------------------------------------------------------------------
// Helpers for evaluating transformed code
// ---------------------------------------------------------------------------

/**
 * Transforms source written as JS (no type annotations), strips
 * imports/exports so the result can be evaluated, then runs it and
 * returns the objects it produced.
 *
 * Important: test sources must be plain JavaScript — no TypeScript
 * type annotations. The transform uses the parser to find `execute`
 * functions and doesn't care about types; what matters is that the
 * *output* evaluates correctly.
 */
async function transformAndEval(
  filename: string,
  source: string,
  handlerArgs: Record<string, unknown> = {},
): Promise<{
  code: string;
  registry: Map<string, Function>;
  callHandler: () => Promise<Record<string, unknown>>;
}> {
  const result = await transformDynamicToolExecute(filename, source);
  if (!result) throw new Error("Transform returned null");

  let code = result.code;
  // Strip imports
  code = code.replace(/import\s+[^;]+;/g, "");
  // Strip `export default`
  code = code.replace(/export\s+default\s+/g, "var __exported = ");
  // Strip `export const ...`
  code = code.replace(/export\s+const\s+/g, "const ");

  const capturedHandler: { fn: Function | null } = { fn: null };

  const defineDynamic = (def: { events: Record<string, Function> }) => {
    const eventName = Object.keys(def.events)[0]!;
    capturedHandler.fn = def.events[eventName]!;
    return def;
  };

  const defineTool = (entry: Record<string, unknown>) =>
    Object.assign(entry, { [Symbol.for("eve:tool-brand")]: true });

  // Evaluate in a function scope to provide our stubs. The transform
  // prepends its own __eveStepRegistry setup, so we don't need to add it.
  const evalFn = new Function("defineDynamic", "defineTool", `${code}\nreturn __exported;`);
  evalFn(defineDynamic, defineTool);

  const registrySym = Symbol.for("@workflow/core//registeredSteps");
  const registry = (globalThis as Record<symbol, Map<string, Function>>)[registrySym] ?? new Map();

  return {
    code,
    registry,
    callHandler: async () => {
      if (!capturedHandler.fn) throw new Error("No handler captured");
      const event = handlerArgs.event ?? {};
      const ctx = handlerArgs.ctx ?? { session: { id: "test-123", auth: { current: null } } };
      return capturedHandler.fn(event, ctx) as Promise<Record<string, unknown>>;
    },
  };
}

// Clear step registry between tests so counter-based names don't collide
beforeEach(() => {
  const sym = Symbol.for("@workflow/core//registeredSteps");
  const reg = (globalThis as Record<symbol, Map<string, Function> | undefined>)[sym];
  if (reg) reg.clear();
});

// ===========================================================================
// Section 1: Evaluation tests — prove the generated code ACTUALLY WORKS
// ===========================================================================

describe("transformDynamicToolExecute — evaluation", () => {
  it("wrapper calls hoisted function with correct closure vars", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const apiUrl = "https://api.example.com";
      const tenantName = "Acme";
      return {
        query: defineTool({
          description: "Query",
          inputSchema: { type: "object" },
          execute(input) {
            return { url: apiUrl, tenant: tenantName, q: input.q };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/tenant.ts", source);
    const tools = await callHandler();
    const query = tools.query as Record<string, unknown>;

    // Call the wrapper — it should invoke the hoisted function with __vars
    const execFn = query.execute as Function;
    const result = execFn({ q: "search term" });

    expect(result).toEqual({
      url: "https://api.example.com",
      tenant: "Acme",
      q: "search term",
    });
  });

  it("__closureVars captures a snapshot at resolver return time", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const config = { endpoint: "/api/v1", retries: 3 };
      return {
        tool: defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute() { return config.endpoint; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/snapshot.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string, unknown>;

    // __closureVars should have a snapshot of the config
    const closureVars = tool.__closureVars as Record<string, unknown>;
    expect(closureVars).toBeDefined();
    const config = closureVars.config as Record<string, unknown>;
    expect(config.endpoint).toBe("/api/v1");
    expect(config.retries).toBe(3);
  });

  it("__executeStepFn is registered and callable", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const multiplier = 10;
      return {
        calc: defineTool({
          description: "Calc",
          inputSchema: { type: "object" },
          execute(input) { return input.x * multiplier; },
        }),
      };
    },
  },
});
`;

    const { callHandler, registry } = await transformAndEval("tools/calc.ts", source);
    const tools = await callHandler();
    const calc = tools.calc as Record<string, unknown>;

    // __executeStepFn should be a function registered in the step registry
    const stepFn = calc.__executeStepFn as Function & { stepId?: string };
    expect(typeof stepFn).toBe("function");
    expect(stepFn.stepId).toBeDefined();
    expect(registry.has(stepFn.stepId!)).toBe(true);

    // Calling the step function directly with __vars and input should work
    const result = stepFn({ multiplier: 10 }, { x: 5 });
    expect(result).toBe(50);
  });

  it("replay path: step function + stored closure vars produce correct result", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const prefix = "RESULT";
      const separator = "::";
      return {
        format: defineTool({
          description: "Format",
          inputSchema: { type: "object" },
          execute(input) { return prefix + separator + input.value; },
        }),
      };
    },
  },
});
`;

    const { callHandler, registry } = await transformAndEval("tools/format.ts", source);
    const tools = await callHandler();
    const format = tools.format as Record<string, unknown>;

    // Simulate what the replay path does:
    // 1. Get the step function from registry
    const stepFn = format.__executeStepFn as Function & { stepId: string };
    const registeredFn = registry.get(stepFn.stepId)!;
    expect(registeredFn).toBeDefined();

    // 2. Get the serialized closure vars (simulating JSON round-trip)
    const closureVars = JSON.parse(JSON.stringify(format.__closureVars));

    // 3. Call the step function with stored vars + new input
    const result = registeredFn(closureVars, { value: "hello" });
    expect(result).toBe("RESULT::hello");
  });

  it("multiple tools in same resolver each get independent wrappers", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const db = "prod-db";
      return {
        read_data: defineTool({
          description: "Read",
          inputSchema: { type: "object" },
          execute(input) { return { op: "read", db, table: input.table }; },
        }),
        write_data: defineTool({
          description: "Write",
          inputSchema: { type: "object" },
          execute(input) { return { op: "write", db, record: input.record }; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/multi.ts", source);
    const tools = await callHandler();

    const readExec = (tools.read_data as Record<string, unknown>).execute as Function;
    const writeExec = (tools.write_data as Record<string, unknown>).execute as Function;

    expect(readExec({ table: "users" })).toEqual({
      op: "read",
      db: "prod-db",
      table: "users",
    });
    expect(writeExec({ record: { id: 1 } })).toEqual({
      op: "write",
      db: "prod-db",
      record: { id: 1 },
    });

    // Each tool should have a different step function
    const readStepFn = (tools.read_data as Record<string, unknown>).__executeStepFn as Function;
    const writeStepFn = (tools.write_data as Record<string, unknown>).__executeStepFn as Function;
    expect(readStepFn).not.toBe(writeStepFn);
  });

  it("async execute preserves await semantics", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const baseUrl = "https://api.test";
      return {
        fetch_data: defineTool({
          description: "Fetch",
          inputSchema: { type: "object" },
          async execute(input) {
            const url = baseUrl + "/" + input.path;
            return { fetched: url };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/async.ts", source);
    const tools = await callHandler();
    const execFn = (tools.fetch_data as Record<string, unknown>).execute as Function;

    // Async execute should return a Promise
    const result = execFn({ path: "users" });
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ fetched: "https://api.test/users" });
  });

  it("for-of loop tools each capture their iteration variable", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tools = {};
      const prefix = "tool";
      for (const name of ["alpha", "beta"]) {
        tools[name] = defineTool({
          description: name,
          inputSchema: { type: "object" },
          execute() { return prefix + "_" + name; },
        });
      }
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/loop.ts", source);
    const tools = await callHandler();

    // Both tools share the same hoisted function but get different
    // __closureVars snapshots because `name` is captured at wrapper
    // call time (the for-of body runs twice, each time `name` has a
    // different value).
    const alphaExec = (tools.alpha as Record<string, unknown>).execute as Function;
    const betaExec = (tools.beta as Record<string, unknown>).execute as Function;

    // The for-of `const name` rebinds each iteration, so the wrapper
    // captures the current value of `name` at the time the object is
    // created. Both wrappers call the SAME hoisted function but with
    // different __vars.
    const alphaResult = alphaExec();
    const betaResult = betaExec();

    expect(alphaResult).toBe("tool_alpha");
    expect(betaResult).toBe("tool_beta");
  });

  it("for-of with array destructuring and derived vars captures closure correctly", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "action.result": async () => {
      const apis = { billing: { endpoint: "https://billing.api" }, users: { endpoint: "https://users.api" } };
      const tools = {};
      for (const [name, api] of Object.entries(apis)) {
        const endpoint = api.endpoint;
        tools[name] = defineTool({
          description: "Call " + name,
          inputSchema: { type: "object" },
          async execute() {
            return { called: name, endpoint: endpoint };
          },
        });
      }
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/for-of-destruct.ts", source);
    const tools = await callHandler();

    const billingExec = (tools.billing as Record<string, unknown>).execute as Function;
    const usersExec = (tools.users as Record<string, unknown>).execute as Function;

    expect(await billingExec()).toEqual({ called: "billing", endpoint: "https://billing.api" });
    expect(await usersExec()).toEqual({ called: "users", endpoint: "https://users.api" });
  });

  it("for-of with defineTool() wrapper and action.result event captures closure correctly", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

function defineTool(entry) {
  return Object.assign(entry, { [Symbol.for("eve:tool-brand")]: true });
}

export default defineDynamic({
  events: {
    "action.result": async () => {
      const apis = { billing: { endpoint: "https://billing.api" } };
      const tools = {};
      for (const [name, api] of Object.entries(apis)) {
        const endpoint = api.endpoint;
        tools[name] = defineTool({
          description: "Call " + name,
          inputSchema: { type: "object" },
          async execute() {
            return { called: name, endpoint: endpoint };
          },
        });
      }
      return tools;
    },
  },
});
`;

    const { callHandler, code } = await transformAndEval("tools/action-result-tool.ts", source);
    // Verify the transform injected __executeStepFn
    expect(code).toContain("__executeStepFn");
    expect(code).toContain("__closureVars");

    const tools = await callHandler();
    const billingEntry = tools.billing as Record<string, unknown>;
    expect(billingEntry.__executeStepFn).toBeDefined();
    expect(billingEntry.__closureVars).toBeDefined();

    const execFn = billingEntry.execute as Function;
    expect(await execFn()).toEqual({ called: "billing", endpoint: "https://billing.api" });
  });

  it("execute inside defineTool() inside a helper function captures closure vars", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const baseUrl = "https://api.example.com";

      function buildTool(action) {
        const endpoint = baseUrl + "/" + action;
        return defineTool({
          description: "Call " + action,
          inputSchema: { type: "object" },
          async execute(input) {
            return { endpoint, action, query: input.q };
          },
        });
      }

      return {
        search: buildTool("search"),
        export: buildTool("export"),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/helper-fn.ts", source);
    const tools = await callHandler();

    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const exportExec = (tools.export as Record<string, unknown>).execute as Function;

    expect(await searchExec({ q: "test" })).toEqual({
      endpoint: "https://api.example.com/search",
      action: "search",
      query: "test",
    });
    expect(await exportExec({ q: "all" })).toEqual({
      endpoint: "https://api.example.com/export",
      action: "export",
      query: "all",
    });

    // Both should have __executeStepFn for replay
    expect((tools.search as Record<string, unknown>).__executeStepFn).toBeDefined();
    expect((tools.export as Record<string, unknown>).__executeStepFn).toBeDefined();
  });

  it("description computed by a function is captured at event time, not re-evaluated", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      let counter = 0;
      function makeDescription(name) {
        counter++;
        return "Tool " + name + " (v" + counter + ")";
      }

      return {
        alpha: defineTool({
          description: makeDescription("alpha"),
          inputSchema: { type: "object" },
          execute() { return { counter }; },
        }),
        beta: defineTool({
          description: makeDescription("beta"),
          inputSchema: { type: "object" },
          execute() { return { counter }; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/desc-fn.ts", source);
    const tools = await callHandler();

    // Descriptions were computed at event time — counter was 1 and 2
    expect((tools.alpha as Record<string, unknown>).description).toBe("Tool alpha (v1)");
    expect((tools.beta as Record<string, unknown>).description).toBe("Tool beta (v2)");

    // Closure vars are captured at wrapper call time. Alpha was
    // created when counter was 1, beta when counter was 2.
    const alphaVars = (tools.alpha as Record<string, unknown>).__closureVars as Record<
      string,
      unknown
    >;
    const betaVars = (tools.beta as Record<string, unknown>).__closureVars as Record<
      string,
      unknown
    >;
    expect(alphaVars.counter).toBe(1);
    expect(betaVars.counter).toBe(2);
  });

  it("if/else branches each produce a working tool", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const mode = "production";
      if (mode === "production") {
        return {
          tool: defineTool({
            description: "Prod tool",
            inputSchema: { type: "object" },
            execute() { return { env: mode, safe: true }; },
          }),
        };
      }
      return {
        tool: defineTool({
          description: "Dev tool",
          inputSchema: { type: "object" },
          execute() { return { env: mode, safe: false }; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/branch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn()).toEqual({ env: "production", safe: true });
  });

  it("expression-body arrow execute returns correct value", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const factor = 2;
      return {
        double: defineTool({
          description: "Double",
          inputSchema: { type: "object" },
          execute: (input) => input.n * factor,
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/expr.ts", source);
    const tools = await callHandler();
    const execFn = (tools.double as Record<string, unknown>).execute as Function;

    expect(execFn({ n: 21 })).toBe(42);
  });

  it("execute with no params works", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const secret = "s3cr3t";
      return {
        reveal: defineTool({
          description: "Reveal",
          inputSchema: { type: "object" },
          execute() { return secret; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/noparam.ts", source);
    const tools = await callHandler();
    const execFn = (tools.reveal as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("s3cr3t");
  });

  it("switch/case correctly hoists execute from each branch", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tier = "premium";
      switch (tier) {
        case "premium":
          return {
            tool: defineTool({
              description: "Premium",
              inputSchema: { type: "object" },
              execute() { return { tier, limit: 1000 }; },
            }),
          };
        default:
          return {
            tool: defineTool({
              description: "Free",
              inputSchema: { type: "object" },
              execute() { return { tier, limit: 10 }; },
            }),
          };
      }
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/switch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn()).toEqual({ tier: "premium", limit: 1000 });
  });

  it("try/catch hoists execute from both branches", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const fallbackMsg = "service unavailable";
      try {
        const config = { ready: true };
        return {
          tool: defineTool({
            description: "Live",
            inputSchema: { type: "object" },
            execute() { return { status: "live", ready: config.ready }; },
          }),
        };
      } catch (e) {
        return {
          tool: defineTool({
            description: "Fallback",
            inputSchema: { type: "object" },
            execute() { return { status: "fallback", msg: fallbackMsg }; },
          }),
        };
      }
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/trycatch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    // The try branch succeeds, so we get the "live" tool
    expect(execFn()).toEqual({ status: "live", ready: true });
  });

  it("replay simulation: JSON round-trip of closure vars produces same result", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const config = {
        endpoints: { search: "/api/search", export: "/api/export" },
        maxResults: 100,
        flags: [true, false, true],
      };
      return {
        search: defineTool({
          description: "Search",
          inputSchema: { type: "object" },
          execute(input) {
            return {
              url: config.endpoints.search,
              limit: config.maxResults,
              query: input.q,
              flagCount: config.flags.filter(Boolean).length,
            };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler, registry } = await transformAndEval("tools/replay.ts", source);
    const tools = await callHandler();
    const search = tools.search as Record<string, unknown>;

    // Live call
    const liveResult = (search.execute as Function)({ q: "test" });

    // Replay: serialize → deserialize → call step function
    const stepFn = search.__executeStepFn as Function & { stepId: string };
    const serializedVars = JSON.parse(JSON.stringify(search.__closureVars));
    const registeredFn = registry.get(stepFn.stepId)!;
    const replayResult = registeredFn(serializedVars, { q: "test" });

    // Live and replay must produce identical results
    expect(replayResult).toEqual(liveResult);
    expect(replayResult).toEqual({
      url: "/api/search",
      limit: 100,
      query: "test",
      flagCount: 2,
    });
  });

  it("handler returning null produces no tools and no crash", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return null;
    },
  },
});
`;

    // The transform returns null because there's no execute in the source
    const result = await transformDynamicToolExecute("tools/null-return.ts", source);
    expect(result).toBeNull();
  });

  it("handler conditionally returning null vs tools works for the tools branch", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const enabled = true;
      if (!enabled) return null;
      return {
        tool: defineTool({
          description: "Conditional",
          inputSchema: { type: "object" },
          execute(input) { return { enabled, value: input.v }; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/cond-null.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn({ v: 42 })).toEqual({ enabled: true, value: 42 });
  });

  it("handler conditionally returning null actually returns null when condition is false", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const enabled = false;
      if (!enabled) return null;
      return {
        tool: defineTool({
          description: "Conditional",
          inputSchema: { type: "object" },
          execute(input) { return { enabled, value: input.v }; },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/cond-null-off.ts", source);
    const result = await callHandler();

    // Handler returns null — no tools for this session
    expect(result).toBeNull();
  });

  it("multiple resolvers: one returns null, other returns tools", async () => {
    // This tests that a single file can have a handler that sometimes
    // returns null. The transform still hoists the execute for the
    // non-null branch.
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const featureA = false;
      const featureB = true;

      if (featureA) {
        return {
          feature_a: defineTool({
            description: "Feature A",
            inputSchema: { type: "object" },
            execute() { return "a"; },
          }),
        };
      }

      if (featureB) {
        return {
          feature_b: defineTool({
            description: "Feature B",
            inputSchema: { type: "object" },
            execute() { return "b"; },
          }),
        };
      }

      return null;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/multi-null.ts", source);
    const tools = await callHandler();

    // featureA is false, featureB is true → should get feature_b
    const execFn = (tools.feature_b as Record<string, unknown>).execute as Function;
    expect(execFn()).toBe("b");
    expect(tools.feature_a).toBeUndefined();
  });

  it("closure vars with non-serializable values: functions are dropped on replay", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const label = "test";
      const helper = function(x) { return x * 2; };
      return {
        tool: defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute(input) { return label + ":" + helper(input.n); },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/non-serial.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string, unknown>;

    // Live call works because helper is a real closure
    const liveResult = (tool.execute as Function)({ n: 5 });
    expect(liveResult).toBe("test:10");

    // But __closureVars loses the function on JSON round-trip
    const serialized = JSON.parse(JSON.stringify(tool.__closureVars));
    expect(serialized.label).toBe("test");
    expect(serialized.helper).toBeUndefined();
  });

  it("execute param named same as handler param does not collide", async () => {
    // The handler has (event, ctx), the execute also takes (input, ctx).
    // The execute body references handler-scope `tenant` AND execute-param
    // `ctx`. The hoisted function must destructure __vars without shadowing
    // the execute's own `ctx` parameter.
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const tenant = "Acme";
      return {
        tool: defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute(input, ctx) {
            return { tenant, ctxType: typeof ctx, input };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/shadow-ctx.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    // Call with two args: input and a fake ctx object
    const result = execFn({ x: 1 }, { fake: "ctx" });
    expect(result).toEqual({
      tenant: "Acme",
      ctxType: "object",
      input: { x: 1 },
    });
  });

  it("nested function param shadows handler var — inner value wins", async () => {
    // Handler declares `name = "outer"`, helper takes `name` as a param.
    // The execute body uses `name` — it should get the INNER value
    // (the helper's param), not the handler's var.
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const name = "outer";
      function buildTool(name) {
        return defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute() { return name; },
        });
      }
      return { tool: buildTool("inner") };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/shadow-var.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    // The inner `name` ("inner") should shadow the outer `name` ("outer")
    expect(execFn()).toBe("inner");
  });

  it("resolver ctx values are captured separately from execute ctx", async () => {
    // The handler captures ctx.session.id at resolve time.
    // The execute function receives its own ctx with session.turn etc.
    // These are different objects — verify the resolver snapshot is
    // preserved independently of the execute-time context.
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const resolverSessionId = ctx.session.id;
      const resolverHasAuth = ctx.session.auth.current !== null;
      return {
        tool: defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute(_input, executeCtx) {
            return {
              resolverSessionId,
              resolverHasAuth,
              executeCtxType: typeof executeCtx,
              executeHasSession: executeCtx !== undefined && executeCtx !== null,
            };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/ctx-separation.ts", source, {
      ctx: { session: { id: "sess-abc", auth: { current: { principalId: "u1" } } } },
    });
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    const result = execFn({}, { session: { id: "different-ctx" } });
    expect(result).toEqual({
      resolverSessionId: "sess-abc",
      resolverHasAuth: true,
      executeCtxType: "object",
      executeHasSession: true,
    });
  });

  it("block-scoped variables (let in if/for) are captured correctly", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tools = {};
      for (let i = 0; i < 2; i++) {
        const tag = "item" + i;
        tools["t" + i] = defineTool({
          description: tag,
          inputSchema: { type: "object" },
          execute() { return { i, tag }; },
        });
      }
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/block-scope.ts", source);
    const tools = await callHandler();

    const exec0 = (tools.t0 as Record<string, unknown>).execute as Function;
    const exec1 = (tools.t1 as Record<string, unknown>).execute as Function;

    // Each iteration creates its own block-scoped `i` and `tag`.
    // The wrapper captures the current values at object creation time.
    expect(exec0()).toEqual({ i: 0, tag: "item0" });
    expect(exec1()).toEqual({ i: 1, tag: "item1" });
  });

  it("deeply nested scope chain: handler → helper → inner helper", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const orgId = "org-1";
      function buildCategory(category) {
        const prefix = orgId + "/" + category;
        function buildAction(action) {
          const fullPath = prefix + "/" + action;
          return defineTool({
            description: action,
            inputSchema: { type: "object" },
            execute() { return fullPath; },
          });
        }
        return buildAction;
      }
      const userActions = buildCategory("users");
      return {
        list_users: userActions("list"),
        create_user: userActions("create"),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/deep-scope.ts", source);
    const tools = await callHandler();

    const listExec = (tools.list_users as Record<string, unknown>).execute as Function;
    const createExec = (tools.create_user as Record<string, unknown>).execute as Function;

    // fullPath captures all three scope levels:
    // orgId ("org-1") from handler, category ("users") from buildCategory,
    // action ("list"/"create") from buildAction
    expect(listExec()).toBe("org-1/users/list");
    expect(createExec()).toBe("org-1/users/create");
  });
});

// ===========================================================================
// Section 2: Safety boundary tests — prove dangerous patterns are rejected
// ===========================================================================

describe("transformDynamicToolExecute — safety boundaries", () => {
  it("hoists execute inside a nested helper function with correct scope", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const prefix = "v1";
      function buildTool(name) {
        const endpoint = "/" + prefix + "/" + name;
        return defineTool({
          description: name,
          inputSchema: { type: "object" },
          execute() { return endpoint; },
        });
      }
      return { search: buildTool("search") };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/nested-fn.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("/v1/search");
  });

  it("hoists execute inside an arrow function helper", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const prefix = "api";
      const buildTool = (name) => defineTool({
        description: name,
        inputSchema: { type: "object" },
        execute() { return prefix + "_" + name; },
      });
      return { search: buildTool("search"), create: buildTool("create") };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/nested-arrow.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const createExec = (tools.create as Record<string, unknown>).execute as Function;

    expect(searchExec()).toBe("api_search");
    expect(createExec()).toBe("api_create");
  });

  it("hoists execute inside a .map() callback", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const base = "https://api";
      const names = ["alpha", "beta"];
      const toolMap = {};
      names.forEach(function(name) {
        toolMap[name] = defineTool({
          description: name,
          inputSchema: { type: "object" },
          execute() { return base + "/" + name; },
        });
      });
      return toolMap;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/nested-foreach.ts", source);
    const tools = await callHandler();
    const alphaExec = (tools.alpha as Record<string, unknown>).execute as Function;
    const betaExec = (tools.beta as Record<string, unknown>).execute as Function;

    expect(alphaExec()).toBe("https://api/alpha");
    expect(betaExec()).toBe("https://api/beta");
  });

  it("hoists execute inside an IIFE", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const secret = "s3cr3t";
      const tools = (function() {
        return {
          reveal: defineTool({
            description: "Reveal",
            inputSchema: { type: "object" },
            execute() { return secret; },
          }),
        };
      })();
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/iife.ts", source);
    const tools = await callHandler();
    const execFn = (tools.reveal as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("s3cr3t");
  });

  it("hoists execute inside a .reduce() callback", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const version = "v2";
      const endpoints = [
        { name: "search", path: "/search" },
        { name: "export", path: "/export" },
      ];
      return endpoints.reduce(function(acc, ep) {
        acc[ep.name] = defineTool({
          description: ep.name,
          inputSchema: { type: "object" },
          execute() { return version + ep.path; },
        });
        return acc;
      }, {});
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/reduce.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const exportExec = (tools.export as Record<string, unknown>).execute as Function;

    expect(searchExec()).toBe("v2/search");
    expect(exportExec()).toBe("v2/export");
  });

  it("hoists execute inside doubly-nested helpers", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      function createToolSet(prefix) {
        function makeTool(name) {
          return defineTool({
            description: name,
            inputSchema: { type: "object" },
            execute() { return prefix + "_" + name; },
          });
        }
        return { search: makeTool("search") };
      }
      return createToolSet("v1");
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/double-nested.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("v1_search");
  });

  it("helper result stored in variable, other work done, then returned", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const baseUrl = "https://api.test";
      function buildTools(url) {
        return {
          search: defineTool({
            description: "Search",
            inputSchema: { type: "object" },
            execute(input) { return url + "/search?q=" + input.q; },
          }),
        };
      }
      const tools = buildTools(baseUrl);
      const timestamp = Date.now();
      console.log("tools built at", timestamp);
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/var-then-return.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn({ q: "hello" })).toBe("https://api.test/search?q=hello");
  });

  it("helper result passed through a wrapper function before return", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const version = "v3";
      function buildTool(name) {
        return defineTool({
          description: name,
          inputSchema: { type: "object" },
          execute(input) { return version + "/" + name + "/" + input.id; },
        });
      }
      function wrapTools(toolSet) {
        return toolSet;
      }
      return wrapTools({ search: buildTool("search"), list: buildTool("list") });
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/wrapped-return.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const listExec = (tools.list as Record<string, unknown>).execute as Function;

    expect(searchExec({ id: "42" })).toBe("v3/search/42");
    expect(listExec({ id: "99" })).toBe("v3/list/99");
  });

  it("helper result stored in variable, mutated, then returned", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const org = "acme";
      function makeTool(action) {
        return defineTool({
          description: action,
          inputSchema: { type: "object" },
          execute(input) { return org + ":" + action + ":" + input.target; },
        });
      }
      const tools = {};
      tools.read = makeTool("read");
      tools.write = makeTool("write");
      tools.delete_item = makeTool("delete");
      return tools;
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/incremental-build.ts", source);
    const tools = await callHandler();
    const readExec = (tools.read as Record<string, unknown>).execute as Function;
    const writeExec = (tools.write as Record<string, unknown>).execute as Function;
    const deleteExec = (tools.delete_item as Record<string, unknown>).execute as Function;

    expect(readExec({ target: "db" })).toBe("acme:read:db");
    expect(writeExec({ target: "cache" })).toBe("acme:write:cache");
    expect(deleteExec({ target: "tmp" })).toBe("acme:delete:tmp");
  });

  it("helper result stored in variable with replay round-trip", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tenant = { name: "Acme", region: "us-east" };
      function createTool(tenant) {
        const label = tenant.name + " (" + tenant.region + ")";
        return {
          info: defineTool({
            description: "Info",
            inputSchema: { type: "object" },
            execute() { return label; },
          }),
        };
      }
      const tools = createTool(tenant);
      return tools;
    },
  },
});
`;

    const { callHandler, registry } = await transformAndEval("tools/var-replay.ts", source);
    const tools = await callHandler();
    const info = tools.info as Record<string, unknown>;

    // Live
    const liveResult = (info.execute as Function)();
    expect(liveResult).toBe("Acme (us-east)");

    // Replay
    const stepFn = info.__executeStepFn as Function & { stepId: string };
    const serializedVars = JSON.parse(JSON.stringify(info.__closureVars));
    const registeredFn = registry.get(stepFn.stepId)!;
    const replayResult = registeredFn(serializedVars);

    expect(replayResult).toBe("Acme (us-east)");
  });

  it("nested helper replay: JSON round-trip produces same result", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const config = { base: "https://api.example.com" };
      function buildTool(name) {
        const url = config.base + "/" + name;
        return defineTool({
          description: name,
          inputSchema: { type: "object" },
          execute(input) { return { url, query: input.q }; },
        });
      }
      return { search: buildTool("search") };
    },
  },
});
`;

    const { callHandler, registry } = await transformAndEval("tools/nested-replay.ts", source);
    const tools = await callHandler();
    const search = tools.search as Record<string, unknown>;

    // Live call
    const liveResult = (search.execute as Function)({ q: "test" });

    // Replay
    const stepFn = search.__executeStepFn as Function & { stepId: string };
    const serializedVars = JSON.parse(JSON.stringify(search.__closureVars));
    const registeredFn = registry.get(stepFn.stepId)!;
    const replayResult = registeredFn(serializedVars, { q: "test" });

    expect(replayResult).toEqual(liveResult);
    expect(replayResult).toEqual({ url: "https://api.example.com/search", query: "test" });
  });

  it("returns null when execute value is a variable reference (not inline function)", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const endpoint = "/api";
      const myExec = (input) => endpoint + input.path;
      return {
        search: {
          description: "Search",
          inputSchema: { type: "object" },
          execute: myExec,
        },
      };
    },
  },
});
`;

    // execute: myExec — the value is an Identifier, not a
    // FunctionExpression/ArrowFunctionExpression. The transform cannot
    // hoist it. First step works (live closure), replay fails silently.
    const result = await transformDynamicToolExecute("tools/var-exec.ts", source);
    expect(result).toBeNull();
  });

  it("returns null when execute value is a factory return", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      function makeExec(endpoint) {
        return async (input) => {
          return endpoint + input.path;
        };
      }
      const exec = makeExec("/api");
      return {
        search: {
          description: "Search",
          inputSchema: { type: "object" },
          execute: exec,
        },
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/factory-exec.ts", source);
    expect(result).toBeNull();
  });

  it("returns null when execute value is a method call (e.g. .bind())", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const client = { search(input) { return input; } };
      return {
        search: {
          description: "Search",
          inputSchema: { type: "object" },
          execute: client.search.bind(client),
        },
      };
    },
  },
});
`;

    // execute: client.search.bind(client) — the value is a
    // CallExpression, not a function literal.
    const result = await transformDynamicToolExecute("tools/bind-exec.ts", source);
    expect(result).toBeNull();
  });

  it("returns null for static defineTool without events", async () => {
    const source = `
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Get weather",
  inputSchema: { type: "object" },
  async execute(input) {
    return await fetchWeather(input.location);
  },
});
`;
    expect(await transformDynamicToolExecute("tools/weather.ts", source)).toBeNull();
  });

  it("returns null for files without defineDynamic", async () => {
    const source = `export const x = 42;`;
    expect(await transformDynamicToolExecute("lib/util.ts", source)).toBeNull();
  });

  it("returns null for defineDynamic without execute", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      return null;
    },
  },
});
`;
    expect(await transformDynamicToolExecute("tools/null.ts", source)).toBeNull();
  });
});

// ===========================================================================
// Section 3: Structural invariant tests — verify the shape of generated code
// ===========================================================================

describe("transformDynamicToolExecute — structural invariants", () => {
  it("every hoisted function has balanced braces", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const data = await fetchData(ctx.session.id);
      return {
        tool_a: defineTool({
          description: "A",
          inputSchema: {},
          async execute(input) {
            if (input.x > 0) {
              return { positive: true, data };
            }
            return { positive: false, data };
          },
        }),
        tool_b: defineTool({
          description: "B",
          inputSchema: {},
          execute: (input) => ({ result: data, input }),
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/braces.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // Extract all hoisted function bodies
    const fnPattern = /function __eve_dynamic_exec_\d+[^{]*(\{[\s\S]*?\n\})/g;
    let match;
    let count = 0;
    while ((match = fnPattern.exec(code)) !== null) {
      const fnBody = match[1]!;
      const opens = (fnBody.match(/\{/g) || []).length;
      const closes = (fnBody.match(/\}/g) || []).length;
      expect(opens).toBe(closes);
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("every execute replacement includes __executeStepFn and __closureVars", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const a = 1;
      return {
        t1: defineTool({ description: "1", inputSchema: {}, execute() { return a; } }),
        t2: defineTool({ description: "2", inputSchema: {}, execute() { return a + 1; } }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/markers.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    const executeCount = (code.match(/execute:/g) || []).length;
    const stepFnCount = (code.match(/__executeStepFn:/g) || []).length;
    const closureVarsCount = (code.match(/__closureVars:/g) || []).length;

    // Each execute replacement should have exactly one __executeStepFn
    // and one __closureVars sibling
    expect(executeCount).toBe(stepFnCount);
    expect(executeCount).toBe(closureVarsCount);
    expect(executeCount).toBeGreaterThanOrEqual(2);
  });

  it("hoisted functions are registered in the step registry before use", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        tool: defineTool({
          description: "T",
          inputSchema: {},
          execute() { return 1; },
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/order.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // Function definition must come before registry.set
    const fnDefIndex = code.indexOf("function __eve_dynamic_exec_");
    const registrySetIndex = code.indexOf("__eveStepRegistry.set");
    expect(fnDefIndex).toBeLessThan(registrySetIndex);
    expect(fnDefIndex).toBeGreaterThan(-1);
    expect(registrySetIndex).toBeGreaterThan(-1);
  });

  it("only vars referenced in execute body are captured in __vars", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const alpha = 1;
      const beta = 2;
      const unused = 999;
      return {
        tool: defineTool({
          description: "T",
          inputSchema: {},
          execute() { return { alpha, beta }; },
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/refvars.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    const destructureMatch = code.match(/const \{([^}]+)\} = __vars/);
    expect(destructureMatch).not.toBeNull();
    const captured = destructureMatch![1]!.split(",").map((s) => s.trim());

    // Only vars the body references should be captured
    expect(captured).toContain("alpha");
    expect(captured).toContain("beta");
    // Unreferenced vars should NOT be captured
    expect(captured).not.toContain("unused");
    expect(captured).not.toContain("event");
    expect(captured).not.toContain("ctx");
  });

  it("no duplicate __vars bindings when execute has no overlapping params", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const value = 42;
      return {
        tool: defineTool({
          description: "T",
          inputSchema: {},
          execute(input) { return value + input.x; },
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/nobinding.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // The hoisted function signature should be: __vars, input
    // The body should destructure: const { event, ctx, value } = __vars
    // There must be no name collision between `input` (param) and the
    // destructured vars
    const fnMatch = code.match(
      /function __eve_dynamic_exec_\d+\(([^)]+)\)\s*\{\s*\n\s*const \{([^}]+)\} = __vars/,
    );
    expect(fnMatch).not.toBeNull();

    const params = fnMatch![1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "__vars");
    const destructured = fnMatch![2]!.split(",").map((s) => s.trim());

    // No name should appear in both
    const overlap = params.filter((p) => destructured.includes(p));
    expect(overlap).toEqual([]);
  });

  it("handles defineDynamic with single-tool return", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const flags = { analytics: true };
      return defineTool({
        description: "Analytics",
        inputSchema: { type: "object" },
        execute(input) { return { flags, input }; },
      });
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/singular.ts", source);
    expect(result).not.toBeNull();
    expect(result!.code).toContain("__eve_dynamic_exec_");
    expect(result!.code).toContain("__eveStepRegistry");
  });

  it("preserves imports and module-level declarations", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

const MODULE_CONSTANT = "hello";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        tool: defineTool({
          description: MODULE_CONSTANT,
          inputSchema: {},
          execute() { return MODULE_CONSTANT; },
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/preserve.ts", source);
    expect(result).not.toBeNull();
    expect(result!.code).toContain('import { defineDynamic, defineTool } from "eve/tools"');
    expect(result!.code).toContain('const MODULE_CONSTANT = "hello"');
  });

  it("captures for-of loop iteration variables", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tools = {};
      for (const item of getItems()) {
        tools[item.name] = defineTool({
          description: item.name,
          inputSchema: { type: "object" },
          execute() { return item.value; },
        });
      }
      return tools;
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/forof.ts", source);
    expect(result).not.toBeNull();

    // The for-of variable `item` should be captured
    const code = result!.code;
    const destructureMatch = code.match(/const \{([^}]+)\} = __vars/);
    expect(destructureMatch).not.toBeNull();
    const captured = destructureMatch![1]!.split(",").map((s) => s.trim());
    expect(captured).toContain("item");
  });

  it("handles both session.started and step.started handlers", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const sessionVal = "s";
      return {
        s_tool: defineTool({ description: "S", inputSchema: {}, execute() { return sessionVal; } }),
      };
    },
    "step.started": async () => {
      const stepVal = "p";
      return {
        p_tool: defineTool({ description: "P", inputSchema: {}, execute() { return stepVal; } }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/multi-event.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // Should have at least 2 unique hoisted functions
    const matches = code.match(/__eve_dynamic_exec_\d+/g) ?? [];
    const unique = new Set(matches);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("the dynamic-ctx fixture pattern works end-to-end", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (event, ctx) => {
      const resolverSessionId = ctx.session.id;

      return {
        check_ctx: defineTool({
          description: "Check",
          inputSchema: { type: "object" },
          execute(_input, executeCtx) {
            return {
              resolverSessionId,
              executeCtxType: typeof executeCtx,
            };
          },
        }),
      };
    },
  },
});
`;

    const { callHandler } = await transformAndEval("tools/ctx.ts", source, {
      ctx: { session: { id: "sess-42", auth: { current: null } } },
    });
    const tools = await callHandler();
    const execFn = (tools.check_ctx as Record<string, unknown>).execute as Function;

    const result = execFn({}, { injected: true });
    expect(result).toEqual({
      resolverSessionId: "sess-42",
      executeCtxType: "object",
    });
  });

  it("typed params with generic commas (Record<string, unknown>) are handled correctly", async () => {
    const source = `
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async () => {
      const tag = "typed";
      return {
        tool: defineTool({
          description: "T",
          inputSchema: { type: "object" },
          execute(_input: Record<string, unknown>, ctx: import("eve/tools").ToolContext) {
            return { tag, hasCtx: ctx !== undefined };
          },
        }),
      };
    },
  },
});
`;

    const result = await transformDynamicToolExecute("tools/generic-params.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // The wrapper call args should be `{ tag }, _input, ctx` — NOT
    // `{ tag }, _input, unknown>, ctx` which the old naive comma split
    // would have produced.
    const wrapperCallMatch = code.match(/__eve_dynamic_exec_\d+\(([^)]+)\)/);
    expect(wrapperCallMatch).not.toBeNull();
    const wrapperArgs = wrapperCallMatch![1]!;
    expect(wrapperArgs).not.toMatch(/\bunknown>\b/);
    // Should have the hoisted function
    expect(code).toContain("__eve_dynamic_exec_");
  });
});
