import { z } from "#compiled/zod/index.js";
import { defineDurableSchema } from "#tools/durable-schema.js";
import { isToolSchema } from "#tools/schema.js";
import { describe, expect, it, beforeEach } from "vitest";

import { transformDynamicToolExecute } from "./dynamic-tool-transform.js";
import {
  collectDurableDynamicToolCallbacks,
  readDurableDynamicCallback,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";

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

  const defineTool = (entry: Record<string, unknown>) => {
    stampDurableDynamicToolCallbacks(
      entry,
      collectDurableDynamicToolCallbacks({
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
        label: entry.label as { complete?: never; delta?: never; start?: never } | undefined,
        approval: entry.approval as never,
        execute: entry.execute as never,
        toModelOutput: entry.toModelOutput as never,
      }),
    );
    return Object.assign(entry, { [Symbol.for("eve:tool-brand")]: true });
  };

  // Evaluate in a function scope to provide our stubs. The transform
  // prepends its own __eveStepRegistry setup, so we don't need to add it.
  const evalFn = new Function(
    "defineDynamic",
    "defineTool",
    "__eveDefineDurableSchema",
    "z",
    `${code}\nreturn __exported;`,
  );
  evalFn(defineDynamic, defineTool, defineDurableSchema, z);

  return {
    code,
    callHandler: async () => {
      if (!capturedHandler.fn) throw new Error("No handler captured");
      const event = handlerArgs.event ?? {};
      const ctx = handlerArgs.ctx ?? { session: { id: "test-123", auth: { current: null } } };
      return capturedHandler.fn(event, ctx) as Promise<Record<string, unknown>>;
    },
  };
}

type StampedCallback = { callback: Function; closure: Record<string, unknown> };
type StampedCallbacks = Record<string, StampedCallback> & {
  label?: { complete?: StampedCallback; delta?: StampedCallback; start?: StampedCallback };
};

function durableCallbacks(tool: unknown): StampedCallbacks {
  return (tool as Record<symbol, StampedCallbacks>)[
    Symbol.for("eve:durable-dynamic-tool-callbacks")
  ]!;
}

// Clear resolve-time registrations between tests so each assertion observes only its module.
beforeEach(() => {
  const sym = Symbol.for("eve:scoped-dynamic-tool-callbacks");
  const reg = (globalThis as Record<symbol, Map<string, Function> | undefined>)[sym];
  if (reg) reg.clear();
});

// ===========================================================================
// Section 1: Evaluation tests — prove the generated code ACTUALLY WORKS
// ===========================================================================

describe("transformDynamicToolExecute — evaluation", () => {
  it("stamps independent durable descriptors for every callback phase", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const labelPrefix = "Deploy";\n      const executePrefix = "execute";\n      const resultPrefix = "Deployed to";\n      const updateSuffix = " sources";\n      const requestReason = "confirm";\n      const promptPrefix = "Review";\n      const allowedResponder = "user-123";\n      const projectionPrefix = "visible";\n      return {\n        guarded: defineTool({\n          description: "Guarded",\n          inputSchema: { type: "object" },\n          label: {\n            start(input) {\n              return labelPrefix + " " + input.value;\n            },\n            complete(_input, output) {\n              return resultPrefix + " " + output.url;\n            },\n            delta(_input, partial) {\n              return partial.phase + updateSuffix;\n            },\n          },\n          approval: {\n            request(ctx) {\n              return ctx.toolInput.force ? { type: "user-approval", reason: requestReason } : "not-applicable";\n            },\n            prompt(ctx) {\n              return promptPrefix + " " + ctx.input.value;\n            },\n            response(ctx) {\n              return ctx.response.principal.principalId === allowedResponder\n                ? { status: "allowed" }\n                : { status: "rejected", reason: "wrong responder" };\n            },\n          },\n          execute(input) {\n            return executePrefix + ":" + input.value;\n          },\n          toModelOutput(output) {\n            return { type: "text", value: projectionPrefix + ":" + output };\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/all-phases.ts", source);
    const tools = await callHandler();
    const guarded = tools.guarded as Record<string | symbol, unknown>;
    const callbacks = durableCallbacks(guarded);

    expect(Object.keys(callbacks)).toEqual([
      "execute",
      "label",
      "approvalPrompt",
      "approvalRequest",
      "approvalResponse",
      "toModelOutput",
    ]);
    expect(callbacks.execute!.closure).toEqual({ executePrefix: "execute" });
    expect(callbacks.label?.start?.closure).toEqual({ labelPrefix: "Deploy" });
    expect(callbacks.label?.complete?.closure).toEqual({ resultPrefix: "Deployed to" });
    expect(callbacks.label?.delta?.closure).toEqual({ updateSuffix: " sources" });
    expect(callbacks.approvalRequest!.closure).toEqual({ requestReason: "confirm" });
    expect(callbacks.approvalPrompt!.closure).toEqual({ promptPrefix: "Review" });
    expect(callbacks.approvalResponse!.closure).toEqual({ allowedResponder: "user-123" });
    expect(callbacks.toModelOutput!.closure).toEqual({ projectionPrefix: "visible" });
    const callbackValues = [
      callbacks.execute,
      callbacks.label?.start,
      callbacks.label?.complete,
      callbacks.label?.delta,
      callbacks.approvalRequest,
      callbacks.approvalPrompt,
      callbacks.approvalResponse,
      callbacks.toModelOutput,
    ];
    expect(new Set(callbackValues.map((callback) => callback!.callback)).size).toBe(8);
    for (const callback of callbackValues) expect(callback!.callback).toBeTypeOf("function");
  });

  it("preserves top-level function-form approval properties", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nfunction referencedApproval() {\n  return "user-approval";\n}\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => ({\n      arrow: defineTool({\n        description: "Arrow approval",\n        inputSchema: { type: "object" },\n        approval: () => "user-approval",\n        execute: async () => "ok",\n      }),\n      method: defineTool({\n        description: "Method approval",\n        inputSchema: { type: "object" },\n        approval() {\n          return "user-approval";\n        },\n        execute: async () => "ok",\n      }),\n      referenced: defineTool({\n        description: "Referenced approval",\n        inputSchema: { type: "object" },\n        approval: referencedApproval,\n        execute: async () => "ok",\n      }),\n    }),\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/function-approval.ts", source);
    const tools = await callHandler();

    for (const entry of Object.values(tools)) {
      const tool = entry as Record<string | symbol, unknown>;
      expect(tool.request).toBeUndefined();
      expect(tool.approval).toBeTypeOf("function");
      expect(await (tool.approval as Function)({})).toBe("user-approval");
      const callbacks = durableCallbacks(tool);
      expect(callbacks.approvalRequest!.closure).toEqual({});
      expect(callbacks.approvalRequest!.callback).toBeTypeOf("function");
    }
  });

  it("wrapper calls hoisted function with correct closure vars", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const apiUrl = "https://api.example.com";\n      const tenantName = "Acme";\n      return {\n        query: defineTool({\n          description: "Query",\n          inputSchema: { type: "object" },\n          execute(input) {\n            return { url: apiUrl, tenant: tenantName, q: input.q };\n          },\n        }),\n      };\n    },\n  },\n});\n';

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

  it("forwards destructured parameters with defaults", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => ({\n      tool: defineTool({\n        description: "T",\n        inputSchema: { type: "object" },\n        async execute({ dryRun = false }, ctx) {\n          return { dryRun, requestId: ctx.requestId };\n        },\n      }),\n    }),\n  },\n});\n';

    const { callHandler, code } = await transformAndEval("tools/default-param.ts", source);
    const tools = await callHandler();
    const execute = (tools.tool as Record<string, unknown>).execute as Function;

    expect(code).toMatch(
      /async \(\.\.\.__args\) => await __eve_dynamic_exec_\d+\(\{\}, \.\.\.__args\)/,
    );
    await expect(execute({}, { requestId: "req-123" })).resolves.toEqual({
      dryRun: false,
      requestId: "req-123",
    });
    await expect(execute({ dryRun: true }, { requestId: "req-456" })).resolves.toEqual({
      dryRun: true,
      requestId: "req-456",
    });
  });

  it("__closureVars captures a snapshot at resolver return time", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const config = { endpoint: "/api/v1", retries: 3 };\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute() { return config.endpoint; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/snapshot.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string | symbol, unknown>;

    // The stamped closure should have a snapshot of the config
    const closureVars = durableCallbacks(tool).execute!.closure;
    expect(closureVars).toBeDefined();
    const config = closureVars.config as Record<string, unknown>;
    expect(config.endpoint).toBe("/api/v1");
    expect(config.retries).toBe(3);
  });

  it("stamped execute callback is callable with snapshotted vars", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const multiplier = 10;\n      return {\n        calc: defineTool({\n          description: "Calc",\n          inputSchema: { type: "object" },\n          execute(input) { return input.x * multiplier; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/calc.ts", source);
    const tools = await callHandler();
    const calc = tools.calc as Record<string, unknown>;

    // The stamped descriptor carries the hoisted implementation
    const stepFn = durableCallbacks(calc).execute!.callback;
    expect(typeof stepFn).toBe("function");

    // Calling the step function directly with __vars and input should work
    const result = stepFn({ multiplier: 10 }, { x: 5 });
    expect(result).toBe(50);
  });

  it("replay path: step function + stored closure vars produce correct result", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const prefix = "RESULT";\n      const separator = "::";\n      return {\n        format: defineTool({\n          description: "Format",\n          inputSchema: { type: "object" },\n          execute(input) { return prefix + separator + input.value; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/format.ts", source);
    const tools = await callHandler();
    const format = tools.format as Record<string, unknown>;

    // Simulate what the replay path does:
    // 1. Get the registered implementation from the stamped descriptor
    const descriptor = durableCallbacks(format).execute!;
    const registeredFn = descriptor.callback;
    expect(registeredFn).toBeTypeOf("function");

    // 2. Get the serialized closure vars (simulating JSON round-trip)
    const closureVars = JSON.parse(JSON.stringify(descriptor.closure));

    // 3. Call the implementation with stored vars + new input
    const result = registeredFn(closureVars, { value: "hello" });
    expect(result).toBe("RESULT::hello");
  });

  it("multiple tools in same resolver each get independent wrappers", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const db = "prod-db";\n      return {\n        read_data: defineTool({\n          description: "Read",\n          inputSchema: { type: "object" },\n          execute(input) { return { op: "read", db, table: input.table }; },\n        }),\n        write_data: defineTool({\n          description: "Write",\n          inputSchema: { type: "object" },\n          execute(input) { return { op: "write", db, record: input.record }; },\n        }),\n      };\n    },\n  },\n});\n';

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
    const readStepFn = durableCallbacks(tools.read_data).execute!.callback;
    const writeStepFn = durableCallbacks(tools.write_data).execute!.callback;
    expect(readStepFn).not.toBe(writeStepFn);
  });

  it("does not capture object keys or text from string literals", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tools = {};\n\n      tools.probe_alpha = defineTool({\n        description: "probe alpha",\n        inputSchema: { type: "object" },\n        execute({ q }) {\n          return { url: "/x/" + q, note: "answer from app tools only" };\n        },\n      });\n\n      {\n        const url = "https://example.com";\n        const cred = { a: 1 };\n        tools.probe_beta = defineTool({\n          description: "probe beta",\n          inputSchema: { type: "object" },\n          execute() {\n            return { target: url, cred };\n          },\n        });\n      }\n\n      return tools;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/reference-analysis.ts", source);
    const tools = await callHandler();
    const alpha = tools.probe_alpha as Record<string, unknown>;
    const beta = tools.probe_beta as Record<string, unknown>;

    expect(durableCallbacks(alpha).execute!.closure).toEqual({});
    expect((alpha.execute as Function)({ q: "one" })).toEqual({
      note: "answer from app tools only",
      url: "/x/one",
    });
    expect(durableCallbacks(beta).execute!.closure).toEqual({
      cred: { a: 1 },
      url: "https://example.com",
    });
    expect((beta.execute as Function)()).toEqual({
      cred: { a: 1 },
      target: "https://example.com",
    });
  });

  it("captures computed keys and defaults inside binding patterns", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const fallback = "missing";\n      const field = "value";\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute(input) {\n            const { [field]: value = fallback } = input;\n            return value;\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/binding-patterns.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string, unknown>;
    const execute = tool.execute as Function;

    expect(durableCallbacks(tool).execute!.closure).toEqual({
      fallback: "missing",
      field: "value",
    });
    expect(execute({})).toBe("missing");
    expect(execute({ value: "present" })).toBe("present");
  });

  // https://github.com/vercel/eve/issues/4860
  it("captures locals bound by an array rest element", async () => {
    const { callHandler } = await transformAndEval(
      "tools/array-rest.ts",
      '\n      import { defineDynamic, defineTool } from "eve/tools";\n      import { z } from "zod";\n      export default defineDynamic({ events: { "beforeTurn": () => {\n        const [first, ...rest] = ["a", "b"];\n        return { pick: defineTool({\n          description: "Pick",\n          inputSchema: z.object({ pick: z.enum([first, ...rest]) }),\n          execute: ({ pick }) => pick,\n        }) };\n      } } });\n    ',
    );
    const { inputSchema } = durableCallbacks((await callHandler()).pick);
    expect(inputSchema!.closure).toEqual({ first: "a", rest: ["b"] });
    const schema = inputSchema!.callback(JSON.parse(JSON.stringify(inputSchema!.closure)));
    if (!isToolSchema(schema)) throw new Error("Expected schema");
    expect(await schema["~standard"].validate({ pick: "b" })).toEqual({ value: { pick: "b" } });
  });

  // https://github.com/vercel/eve/issues/4860
  it("captures a rest parameter of the resolver", async () => {
    const { callHandler } = await transformAndEval(
      "tools/rest-param.ts",
      '\n      import { defineDynamic, defineTool } from "eve/tools";\n      export default defineDynamic({ events: { "beforeTurn": (...args) => ({\n        count: defineTool({\n          description: "Count",\n          inputSchema: { type: "object" },\n          execute: () => args.length,\n        }),\n      }) } });\n    ',
    );
    const tool = (await callHandler()).count as Record<string, unknown>;
    const { execute } = durableCallbacks(tool);
    expect(execute!.closure.args).toHaveLength(2);
    expect(execute!.callback(JSON.parse(JSON.stringify(execute!.closure)), {})).toBe(2);
  });

  it("captures a direct identifier in an arrow expression body", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const result = "captured";\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute: () => result,\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/identifier-expression.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string, unknown>;

    expect(durableCallbacks(tool).execute!.closure).toEqual({ result: "captured" });
    expect((tool.execute as Function)()).toBe("captured");
  });

  it("captures runtime references inside TypeScript expressions", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const TypeName = "type-only";\n      const asserted = "asserted";\n      const nonNull = "non-null";\n      const satisfied = "satisfied";\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute() {\n            return [\n              asserted as TypeName,\n              nonNull!,\n              satisfied satisfies TypeName,\n            ];\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/typescript-expressions.ts", source);

    expect(result).not.toBeNull();
    expect(result!.code).toContain(
      "function __eve_dynamic_exec_0({ asserted, nonNull, satisfied })",
    );
  });

  it("async execute preserves await semantics", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const baseUrl = "https://api.test";\n      return {\n        fetch_data: defineTool({\n          description: "Fetch",\n          inputSchema: { type: "object" },\n          async execute(input) {\n            const url = baseUrl + "/" + input.path;\n            return { fetched: url };\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/async.ts", source);
    const tools = await callHandler();
    const execFn = (tools.fetch_data as Record<string, unknown>).execute as Function;

    // Async execute should return a Promise
    const result = execFn({ path: "users" });
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ fetched: "https://api.test/users" });
  });

  it("for-of loop tools each capture their iteration variable", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tools = {};\n      const prefix = "tool";\n      for (const name of ["alpha", "beta"]) {\n        tools[name] = defineTool({\n          description: name,\n          inputSchema: { type: "object" },\n          execute() { return prefix + "_" + name; },\n        });\n      }\n      return tools;\n    },\n  },\n});\n';

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
    // Verify the transform stamped the callback with its hoisted implementation
    expect(code).toContain("__eveStampDynamicCallback");

    const tools = await callHandler();
    const billingEntry = tools.billing as Record<string, unknown>;
    expect(readDurableDynamicCallback(billingEntry.execute)?.callback).toBeTypeOf("function");

    const execFn = billingEntry.execute as Function;
    expect(await execFn()).toEqual({ called: "billing", endpoint: "https://billing.api" });
  });

  it("execute inside defineTool() inside a helper function captures closure vars", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const baseUrl = "https://api.example.com";\n\n      function buildTool(action) {\n        const endpoint = baseUrl + "/" + action;\n        return defineTool({\n          description: "Call " + action,\n          inputSchema: { type: "object" },\n          async execute(input) {\n            return { endpoint, action, query: input.q };\n          },\n        });\n      }\n\n      return {\n        search: buildTool("search"),\n        export: buildTool("export"),\n      };\n    },\n  },\n});\n';

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

    // Both should have a stamped execute implementation for replay
    expect(durableCallbacks(tools.search as Record<string, symbol>).execute!.callback).toBeTypeOf(
      "function",
    );
    expect(durableCallbacks(tools.export as Record<string, symbol>).execute!.callback).toBeTypeOf(
      "function",
    );
  });

  it("description computed by a function is captured at event time, not re-evaluated", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      let counter = 0;\n      function makeDescription(name) {\n        counter++;\n        return "Tool " + name + " (v" + counter + ")";\n      }\n\n      return {\n        alpha: defineTool({\n          description: makeDescription("alpha"),\n          inputSchema: { type: "object" },\n          execute() { return { counter }; },\n        }),\n        beta: defineTool({\n          description: makeDescription("beta"),\n          inputSchema: { type: "object" },\n          execute() { return { counter }; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/desc-fn.ts", source);
    const tools = await callHandler();

    // Descriptions were computed at event time — counter was 1 and 2
    expect((tools.alpha as Record<string, unknown>).description).toBe("Tool alpha (v1)");
    expect((tools.beta as Record<string, unknown>).description).toBe("Tool beta (v2)");

    // Closure vars are captured at wrapper call time. Alpha was
    // created when counter was 1, beta when counter was 2.
    const alphaVars = durableCallbacks(tools.alpha).execute!.closure;
    const betaVars = durableCallbacks(tools.beta).execute!.closure;
    expect(alphaVars.counter).toBe(1);
    expect(betaVars.counter).toBe(2);
  });

  it("if/else branches each produce a working tool", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const mode = "production";\n      if (mode === "production") {\n        return {\n          tool: defineTool({\n            description: "Prod tool",\n            inputSchema: { type: "object" },\n            execute() { return { env: mode, safe: true }; },\n          }),\n        };\n      }\n      return {\n        tool: defineTool({\n          description: "Dev tool",\n          inputSchema: { type: "object" },\n          execute() { return { env: mode, safe: false }; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/branch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn()).toEqual({ env: "production", safe: true });
  });

  it("expression-body arrow execute returns correct value", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const factor = 2;\n      return {\n        double: defineTool({\n          description: "Double",\n          inputSchema: { type: "object" },\n          execute: (input) => input.n * factor,\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/expr.ts", source);
    const tools = await callHandler();
    const execFn = (tools.double as Record<string, unknown>).execute as Function;

    expect(execFn({ n: 21 })).toBe(42);
  });

  it("execute with no params works", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const secret = "s3cr3t";\n      return {\n        reveal: defineTool({\n          description: "Reveal",\n          inputSchema: { type: "object" },\n          execute() { return secret; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/noparam.ts", source);
    const tools = await callHandler();
    const execFn = (tools.reveal as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("s3cr3t");
  });

  it("switch/case correctly hoists execute from each branch", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tier = "premium";\n      switch (tier) {\n        case "premium":\n          return {\n            tool: defineTool({\n              description: "Premium",\n              inputSchema: { type: "object" },\n              execute() { return { tier, limit: 1000 }; },\n            }),\n          };\n        default:\n          return {\n            tool: defineTool({\n              description: "Free",\n              inputSchema: { type: "object" },\n              execute() { return { tier, limit: 10 }; },\n            }),\n          };\n      }\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/switch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn()).toEqual({ tier: "premium", limit: 1000 });
  });

  it("try/catch hoists execute from both branches", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const fallbackMsg = "service unavailable";\n      try {\n        const config = { ready: true };\n        return {\n          tool: defineTool({\n            description: "Live",\n            inputSchema: { type: "object" },\n            execute() { return { status: "live", ready: config.ready }; },\n          }),\n        };\n      } catch (e) {\n        return {\n          tool: defineTool({\n            description: "Fallback",\n            inputSchema: { type: "object" },\n            execute() { return { status: "fallback", msg: fallbackMsg }; },\n          }),\n        };\n      }\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/trycatch.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    // The try branch succeeds, so we get the "live" tool
    expect(execFn()).toEqual({ status: "live", ready: true });
  });

  it("replay simulation: JSON round-trip of closure vars produces same result", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const config = {\n        endpoints: { search: "/api/search", export: "/api/export" },\n        maxResults: 100,\n        flags: [true, false, true],\n      };\n      return {\n        search: defineTool({\n          description: "Search",\n          inputSchema: { type: "object" },\n          execute(input) {\n            return {\n              url: config.endpoints.search,\n              limit: config.maxResults,\n              query: input.q,\n              flagCount: config.flags.filter(Boolean).length,\n            };\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/replay.ts", source);
    const tools = await callHandler();
    const search = tools.search as Record<string, unknown>;

    // Live call
    const liveResult = (search.execute as Function)({ q: "test" });

    // Replay: serialize → deserialize → call the stamped implementation
    const descriptor = durableCallbacks(search).execute!;
    const serializedVars = JSON.parse(JSON.stringify(descriptor.closure));
    const replayResult = descriptor.callback(serializedVars, { q: "test" });

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      return null;\n    },\n  },\n});\n';

    // The transform returns null because there's no execute in the source
    const result = await transformDynamicToolExecute("tools/null-return.ts", source);
    expect(result).toBeNull();
  });

  it("handler conditionally returning null vs tools works for the tools branch", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const enabled = true;\n      if (!enabled) return null;\n      return {\n        tool: defineTool({\n          description: "Conditional",\n          inputSchema: { type: "object" },\n          execute(input) { return { enabled, value: input.v }; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/cond-null.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    expect(execFn({ v: 42 })).toEqual({ enabled: true, value: 42 });
  });

  it("handler conditionally returning null actually returns null when condition is false", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const enabled = false;\n      if (!enabled) return null;\n      return {\n        tool: defineTool({\n          description: "Conditional",\n          inputSchema: { type: "object" },\n          execute(input) { return { enabled, value: input.v }; },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/cond-null-off.ts", source);
    const result = await callHandler();

    // Handler returns null — no tools for this session
    expect(result).toBeNull();
  });

  it("multiple resolvers: one returns null, other returns tools", async () => {
    // This tests that a single file can have a handler that sometimes
    // returns null. The transform still hoists the execute for the
    // non-null branch.
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const featureA = false;\n      const featureB = true;\n\n      if (featureA) {\n        return {\n          feature_a: defineTool({\n            description: "Feature A",\n            inputSchema: { type: "object" },\n            execute() { return "a"; },\n          }),\n        };\n      }\n\n      if (featureB) {\n        return {\n          feature_b: defineTool({\n            description: "Feature B",\n            inputSchema: { type: "object" },\n            execute() { return "b"; },\n          }),\n        };\n      }\n\n      return null;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/multi-null.ts", source);
    const tools = await callHandler();

    // featureA is false, featureB is true → should get feature_b
    const execFn = (tools.feature_b as Record<string, unknown>).execute as Function;
    expect(execFn()).toBe("b");
    expect(tools.feature_a).toBeUndefined();
  });

  it("preserves non-serializable captures for strict lifecycle validation", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const label = "test";\n      const helper = function(x) { return x * 2; };\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute(input) { return label + ":" + helper(input.n); },\n        }),\n      };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/non-serial.ts", source);
    const tools = await callHandler();
    const tool = tools.tool as Record<string | symbol, unknown>;

    // Live call works because helper is a real closure
    const liveResult = (tool.execute as Function)({ n: 5 });
    expect(liveResult).toBe("test:10");

    const callbacks = tool[Symbol.for("eve:durable-dynamic-tool-callbacks")] as Record<
      string,
      { closure: Record<string, unknown> }
    >;
    expect(callbacks.execute!.closure.label).toBe("test");
    expect(callbacks.execute!.closure.helper).toBeTypeOf("function");
  });

  it("execute param named same as handler param does not collide", async () => {
    // The handler has (event, ctx), the execute also takes (input, ctx).
    // The execute body references handler-scope `tenant` AND execute-param
    // `ctx`. The hoisted function must destructure __vars without shadowing
    // the execute's own `ctx` parameter.
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const tenant = "Acme";\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute(input, ctx) {\n            return { tenant, ctxType: typeof ctx, input };\n          },\n        }),\n      };\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const name = "outer";\n      function buildTool(name) {\n        return defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute() { return name; },\n        });\n      }\n      return { tool: buildTool("inner") };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/shadow-var.ts", source);
    const tools = await callHandler();
    const execFn = (tools.tool as Record<string, unknown>).execute as Function;

    // The inner `name` ("inner") should shadow the outer `name` ("outer")
    expect(execFn()).toBe("inner");
  });

  it("callback bindings that shadow an enclosing name are not captured", async () => {
    // Minifiers reuse short names, so a destructured callback parameter or a
    // callback-local declaration can shadow a binding the tool captures.
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nfunction makeTool(e) {\n  return defineTool({\n    description: "T",\n    inputSchema: { type: "object" },\n    approval: ({ toolInput: e }) => (e?.value === "secret" ? "user-approval" : "not-applicable"),\n    toModelOutput(output) { const e = "local"; return { type: "text", value: e + output }; },\n    execute({ value }) { return e() + ":" + value; },\n  });\n}\n\nexport default defineDynamic({\n  events: { "beforeSession": async () => ({ tool: makeTool(() => "echo") }) },\n});\n';

    const { callHandler } = await transformAndEval("tools/shadow-pattern.ts", source);
    const tool = (await callHandler()).tool as Record<string, Function>;
    const callbacks = durableCallbacks(tool);

    expect(tool.approval!({ toolInput: { value: "secret" } })).toBe("user-approval");
    expect(tool.toModelOutput!("!")).toEqual({ type: "text", value: "local!" });
    expect(tool.execute!({ value: "hi" })).toBe("echo:hi");
    expect(callbacks.approvalRequest!.closure).toEqual({});
    expect(callbacks.toModelOutput!.closure).toEqual({});
    expect(Object.keys(callbacks.execute!.closure)).toEqual(["e"]);
  });

  it("callback parameter defaults can read captured names", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nfunction makeTool(fallback) {\n  return defineTool({\n    description: "T",\n    inputSchema: { type: "object" },\n    execute({ limit = fallback }) { return limit; },\n  });\n}\n\nexport default defineDynamic({\n  events: { "beforeSession": async () => ({ tool: makeTool(10) }) },\n});\n';

    const { callHandler } = await transformAndEval("tools/default-capture.ts", source);
    const tool = (await callHandler()).tool as Record<string, Function>;

    expect(tool.execute!({})).toBe(10);
    expect(tool.execute!({ limit: 3 })).toBe(3);
    expect(durableCallbacks(tool).execute!.closure).toEqual({ fallback: 10 });
  });

  it("resolver ctx values are captured separately from execute ctx", async () => {
    // The handler captures ctx.session.id at resolve time.
    // The execute function receives its own ctx with session.turn etc.
    // These are different objects — verify the resolver snapshot is
    // preserved independently of the execute-time context.
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const resolverSessionId = ctx.session.id;\n      const resolverHasAuth = ctx.session.auth.current !== null;\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute(_input, executeCtx) {\n            return {\n              resolverSessionId,\n              resolverHasAuth,\n              executeCtxType: typeof executeCtx,\n              executeHasSession: executeCtx !== undefined && executeCtx !== null,\n            };\n          },\n        }),\n      };\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tools = {};\n      for (let i = 0; i < 2; i++) {\n        const tag = "item" + i;\n        tools["t" + i] = defineTool({\n          description: tag,\n          inputSchema: { type: "object" },\n          execute() { return { i, tag }; },\n        });\n      }\n      return tools;\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const orgId = "org-1";\n      function buildCategory(category) {\n        const prefix = orgId + "/" + category;\n        function buildAction(action) {\n          const fullPath = prefix + "/" + action;\n          return defineTool({\n            description: action,\n            inputSchema: { type: "object" },\n            execute() { return fullPath; },\n          });\n        }\n        return buildAction;\n      }\n      const userActions = buildCategory("users");\n      return {\n        list_users: userActions("list"),\n        create_user: userActions("create"),\n      };\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const prefix = "v1";\n      function buildTool(name) {\n        const endpoint = "/" + prefix + "/" + name;\n        return defineTool({\n          description: name,\n          inputSchema: { type: "object" },\n          execute() { return endpoint; },\n        });\n      }\n      return { search: buildTool("search") };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/nested-fn.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("/v1/search");
  });

  it("hoists execute inside an arrow function helper", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const prefix = "api";\n      const buildTool = (name) => defineTool({\n        description: name,\n        inputSchema: { type: "object" },\n        execute() { return prefix + "_" + name; },\n      });\n      return { search: buildTool("search"), create: buildTool("create") };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/nested-arrow.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const createExec = (tools.create as Record<string, unknown>).execute as Function;

    expect(searchExec()).toBe("api_search");
    expect(createExec()).toBe("api_create");
  });

  it("hoists execute inside a .map() callback", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const base = "https://api";\n      const names = ["alpha", "beta"];\n      const toolMap = {};\n      names.forEach(function(name) {\n        toolMap[name] = defineTool({\n          description: name,\n          inputSchema: { type: "object" },\n          execute() { return base + "/" + name; },\n        });\n      });\n      return toolMap;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/nested-foreach.ts", source);
    const tools = await callHandler();
    const alphaExec = (tools.alpha as Record<string, unknown>).execute as Function;
    const betaExec = (tools.beta as Record<string, unknown>).execute as Function;

    expect(alphaExec()).toBe("https://api/alpha");
    expect(betaExec()).toBe("https://api/beta");
  });

  it("hoists execute inside an IIFE", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const secret = "s3cr3t";\n      const tools = (function() {\n        return {\n          reveal: defineTool({\n            description: "Reveal",\n            inputSchema: { type: "object" },\n            execute() { return secret; },\n          }),\n        };\n      })();\n      return tools;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/iife.ts", source);
    const tools = await callHandler();
    const execFn = (tools.reveal as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("s3cr3t");
  });

  it("hoists execute inside a .reduce() callback", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const version = "v2";\n      const endpoints = [\n        { name: "search", path: "/search" },\n        { name: "export", path: "/export" },\n      ];\n      return endpoints.reduce(function(acc, ep) {\n        acc[ep.name] = defineTool({\n          description: ep.name,\n          inputSchema: { type: "object" },\n          execute() { return version + ep.path; },\n        });\n        return acc;\n      }, {});\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/reduce.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const exportExec = (tools.export as Record<string, unknown>).execute as Function;

    expect(searchExec()).toBe("v2/search");
    expect(exportExec()).toBe("v2/export");
  });

  it("hoists execute inside doubly-nested helpers", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      function createToolSet(prefix) {\n        function makeTool(name) {\n          return defineTool({\n            description: name,\n            inputSchema: { type: "object" },\n            execute() { return prefix + "_" + name; },\n          });\n        }\n        return { search: makeTool("search") };\n      }\n      return createToolSet("v1");\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/double-nested.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn()).toBe("v1_search");
  });

  it("helper result stored in variable, other work done, then returned", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const baseUrl = "https://api.test";\n      function buildTools(url) {\n        return {\n          search: defineTool({\n            description: "Search",\n            inputSchema: { type: "object" },\n            execute(input) { return url + "/search?q=" + input.q; },\n          }),\n        };\n      }\n      const tools = buildTools(baseUrl);\n      const timestamp = Date.now();\n      const audit = [];\n      audit.push("tools built at " + timestamp);\n      return tools;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/var-then-return.ts", source);
    const tools = await callHandler();
    const execFn = (tools.search as Record<string, unknown>).execute as Function;

    expect(execFn({ q: "hello" })).toBe("https://api.test/search?q=hello");
  });

  it("helper result passed through a wrapper function before return", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const version = "v3";\n      function buildTool(name) {\n        return defineTool({\n          description: name,\n          inputSchema: { type: "object" },\n          execute(input) { return version + "/" + name + "/" + input.id; },\n        });\n      }\n      function wrapTools(toolSet) {\n        return toolSet;\n      }\n      return wrapTools({ search: buildTool("search"), list: buildTool("list") });\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/wrapped-return.ts", source);
    const tools = await callHandler();
    const searchExec = (tools.search as Record<string, unknown>).execute as Function;
    const listExec = (tools.list as Record<string, unknown>).execute as Function;

    expect(searchExec({ id: "42" })).toBe("v3/search/42");
    expect(listExec({ id: "99" })).toBe("v3/list/99");
  });

  it("helper result stored in variable, mutated, then returned", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const org = "acme";\n      function makeTool(action) {\n        return defineTool({\n          description: action,\n          inputSchema: { type: "object" },\n          execute(input) { return org + ":" + action + ":" + input.target; },\n        });\n      }\n      const tools = {};\n      tools.read = makeTool("read");\n      tools.write = makeTool("write");\n      tools.delete_item = makeTool("delete");\n      return tools;\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tenant = { name: "Acme", region: "us-east" };\n      function createTool(tenant) {\n        const label = tenant.name + " (" + tenant.region + ")";\n        return {\n          info: defineTool({\n            description: "Info",\n            inputSchema: { type: "object" },\n            execute() { return label; },\n          }),\n        };\n      }\n      const tools = createTool(tenant);\n      return tools;\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/var-replay.ts", source);
    const tools = await callHandler();
    const info = tools.info as Record<string, unknown>;

    // Live
    const liveResult = (info.execute as Function)();
    expect(liveResult).toBe("Acme (us-east)");

    // Replay
    const descriptor = durableCallbacks(info).execute!;
    const serializedVars = JSON.parse(JSON.stringify(descriptor.closure));
    const replayResult = descriptor.callback(serializedVars);

    expect(replayResult).toBe("Acme (us-east)");
  });

  it("nested helper replay: JSON round-trip produces same result", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const config = { base: "https://api.example.com" };\n      function buildTool(name) {\n        const url = config.base + "/" + name;\n        return defineTool({\n          description: name,\n          inputSchema: { type: "object" },\n          execute(input) { return { url, query: input.q }; },\n        });\n      }\n      return { search: buildTool("search") };\n    },\n  },\n});\n';

    const { callHandler } = await transformAndEval("tools/nested-replay.ts", source);
    const tools = await callHandler();
    const search = tools.search as Record<string, unknown>;

    // Live call
    const liveResult = (search.execute as Function)({ q: "test" });

    // Replay
    const descriptor = durableCallbacks(search).execute!;
    const serializedVars = JSON.parse(JSON.stringify(descriptor.closure));
    const replayResult = descriptor.callback(serializedVars, { q: "test" });

    expect(replayResult).toEqual(liveResult);
    expect(replayResult).toEqual({ url: "https://api.example.com/search", query: "test" });
  });

  it("returns null when execute value is a variable reference (not inline function)", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const endpoint = "/api";\n      const myExec = (input) => endpoint + input.path;\n      return {\n        search: {\n          description: "Search",\n          inputSchema: { type: "object" },\n          execute: myExec,\n        },\n      };\n    },\n  },\n});\n';

    // execute: myExec — the value is an Identifier, not a
    // FunctionExpression/ArrowFunctionExpression. The transform cannot
    // hoist it. First step works (live closure), replay fails silently.
    const result = await transformDynamicToolExecute("tools/var-exec.ts", source);
    expect(result).toBeNull();
  });

  it("returns null when execute value is a factory return", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      function makeExec(endpoint) {\n        return async (input) => {\n          return endpoint + input.path;\n        };\n      }\n      const exec = makeExec("/api");\n      return {\n        search: {\n          description: "Search",\n          inputSchema: { type: "object" },\n          execute: exec,\n        },\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/factory-exec.ts", source);
    expect(result).toBeNull();
  });

  it("returns null when execute value is a method call (e.g. .bind())", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const client = { search(input) { return input; } };\n      return {\n        search: {\n          description: "Search",\n          inputSchema: { type: "object" },\n          execute: client.search.bind(client),\n        },\n      };\n    },\n  },\n});\n';

    // execute: client.search.bind(client) — the value is a
    // CallExpression, not a function literal.
    const result = await transformDynamicToolExecute("tools/bind-exec.ts", source);
    expect(result).toBeNull();
  });

  it("stamps defineTool callbacks independently of the containing module shape", async () => {
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
    const result = await transformDynamicToolExecute("tools/weather.ts", source);
    expect(result?.code).toContain("eve:durable-dynamic-callback");
  });

  it("transforms aliased defineTool imports", async () => {
    const source =
      '\nimport { defineDynamic, defineTool as tool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": () => ({\n      aliased: tool({\n        description: "Aliased",\n        inputSchema: { type: "object" },\n        execute(input) { return input.value; },\n      }),\n    }),\n  },\n});\n';

    const result = await transformDynamicToolExecute("lib/aliased-factory.ts", source);
    expect(result?.code).toContain("aliased: tool({");
    expect(result?.code).toContain("execute: __eveStampDynamicCallback");
  });

  it("supports module-level function references", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nfunction executeMarker(input) {\n  return "module:" + input.value;\n}\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": () => ({\n      marker: defineTool({\n        description: "Marker",\n        inputSchema: { type: "object" },\n        execute: executeMarker,\n      }),\n    }),\n  },\n});\n';

    const { callHandler } = await transformAndEval("lib/module-reference.ts", source);
    const tools = await callHandler();
    const marker = tools.marker as Record<string | symbol, unknown>;
    const execute = durableCallbacks(marker).execute!;

    expect(execute.closure).toEqual({});
    expect(execute.callback(execute.closure, { value: "ok" })).toBe("module:ok");
  });

  it("preserves async generator callbacks", async () => {
    const source = `
import { defineTool } from "eve/tools";
export default defineTool({
  description: "Stream markers",
  inputSchema: {},
  async *execute() {
    yield { phase: "started" };
    yield { phase: "finished" };
  },
});
`;

    const result = await transformDynamicToolExecute("agent/tools/stream.ts", source);
    expect(result?.code).toContain("execute: __eveStampDynamicCallback(async function*");
    expect(result?.code).toContain("async function* __eve_dynamic_exec_");
  });

  it("returns null for files without defineDynamic", async () => {
    const source = `export const x = 42;`;
    expect(await transformDynamicToolExecute("lib/util.ts", source)).toBeNull();
  });

  it("returns null for defineDynamic without execute", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      return null;\n    },\n  },\n});\n';
    expect(await transformDynamicToolExecute("tools/null.ts", source)).toBeNull();
  });

  it.each(["named", "namespace"])(
    "leaves workflow executors unstamped with a %s import",
    async (style) => {
      // The shape the directive transform hands over: bodies hoisted to
      // top-level declarations (here already stubbed) and referenced by name.
      let source = `
import { defineWorkflowTool } from "eve/tools";

async function execute(input) {
  throw new Error("stub");
}
execute.workflowId = "workflow//./agent/tools/deploy//execute";

async function deploy(input) {
  throw new Error("stub");
}
deploy.workflowId = "workflow//./agent/tools/deploy//deploy";

export default defineWorkflowTool({
  description: "Inline body",
  inputSchema: {},
  execute,
  async toModelOutput(output) { return String(output); },
});

export const referenced = defineWorkflowTool({
  description: "Referenced body",
  inputSchema: {},
  execute: deploy,
});
`;
      if (style === "namespace") {
        source = source
          .replace("import { defineWorkflowTool }", "import * as tools")
          .replaceAll("defineWorkflowTool({", "tools.defineWorkflowTool({");
      }
      const result = await transformDynamicToolExecute(
        "agent/tools/deploy.ts",
        source,
        new Set(["execute", "deploy"]),
      );
      expect(result).not.toBeNull();
      expect(result?.code).not.toContain("__eve_dynamic_exec_");
      expect(result?.code).toContain("toModelOutput: __eveStampDynamicCallback(");
    },
  );
});

// ===========================================================================
// Section 3: Structural invariant tests — verify the shape of generated code
// ===========================================================================

describe("transformDynamicToolExecute — structural invariants", () => {
  it("keeps callback ids stable when an unrelated module is transformed", async () => {
    const target = `
import { defineTool } from "eve/tools";
export default defineTool({
  description: "Target",
  inputSchema: {},
  execute() { return "target"; },
});
`;
    const unrelated = `
import { defineTool } from "eve/tools";
export default defineTool({
  description: "Unrelated",
  inputSchema: {},
  execute() { return "unrelated"; },
});
`;

    const before = await transformDynamicToolExecute("agent/lib/target.ts", target);
    await transformDynamicToolExecute("agent/lib/unrelated.ts", unrelated);
    const after = await transformDynamicToolExecute("agent/lib/target.ts", target);

    expect(after!.code).toBe(before!.code);
  });

  it("every hoisted function has balanced braces", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const data = await fetchData(ctx.session.id);\n      return {\n        tool_a: defineTool({\n          description: "A",\n          inputSchema: {},\n          async execute(input) {\n            if (input.x > 0) {\n              return { positive: true, data };\n            }\n            return { positive: false, data };\n          },\n        }),\n        tool_b: defineTool({\n          description: "B",\n          inputSchema: {},\n          execute: (input) => ({ result: data, input }),\n        }),\n      };\n    },\n  },\n});\n';

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

  it("every execute replacement is stamped with its hoisted implementation", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const a = 1;\n      return {\n        t1: defineTool({ description: "1", inputSchema: {}, execute() { return a; } }),\n        t2: defineTool({ description: "2", inputSchema: {}, execute() { return a + 1; } }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/markers.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    const stampedExecuteCount = (code.match(/execute: __eveStampDynamicCallback\(/g) || []).length;

    // Each execute replacement should be wrapped in exactly one stamp call
    expect(stampedExecuteCount).toBe(2);
  });

  it("stamped wrappers reference hoisted implementations", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: {},\n          execute() { return 1; },\n        }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/order.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // Every hoisted function must be defined in the module suffix and
    // referenced by the live stamped wrapper.
    const hoistedNames = [...code.matchAll(/function (__eve_dynamic_\w+)\(/g)].map(
      (match) => match[1]!,
    );
    expect(hoistedNames.length).toBeGreaterThanOrEqual(1);
    for (const name of hoistedNames) {
      expect(code.split(name).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it("only vars referenced in execute body are captured in __vars", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const alpha = 1;\n      const beta = 2;\n      const unused = 999;\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: {},\n          execute() { return { alpha, beta }; },\n        }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/refvars.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    const destructureMatch = code.match(/function __eve_dynamic_exec_\d+\(\{([^}]+)\}/);
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

  it("handles defineDynamic with single-tool return", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const flags = { analytics: true };\n      return defineTool({\n        description: "Analytics",\n        inputSchema: { type: "object" },\n        execute(input) { return { flags, input }; },\n      });\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/singular.ts", source);
    expect(result).not.toBeNull();
    expect(result!.code).toContain("__eve_dynamic_exec_");
    expect(result!.code).toContain("__eveStampDynamicCallback");
  });

  it("preserves imports and module-level declarations", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nconst MODULE_CONSTANT = "hello";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      return {\n        tool: defineTool({\n          description: MODULE_CONSTANT,\n          inputSchema: {},\n          execute() { return MODULE_CONSTANT; },\n        }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/preserve.ts", source);
    expect(result).not.toBeNull();
    expect(result!.code).toContain('import { defineDynamic, defineTool } from "eve/tools"');
    expect(result!.code).toContain('const MODULE_CONSTANT = "hello"');
  });

  it("captures for-of loop iteration variables", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const tools = {};\n      for (const item of getItems()) {\n        tools[item.name] = defineTool({\n          description: item.name,\n          inputSchema: { type: "object" },\n          execute() { return item.value; },\n        });\n      }\n      return tools;\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/forof.ts", source);
    expect(result).not.toBeNull();

    // The for-of variable `item` should be captured
    const code = result!.code;
    const destructureMatch = code.match(/function __eve_dynamic_exec_\d+\(\{([^}]+)\}/);
    expect(destructureMatch).not.toBeNull();
    const captured = destructureMatch![1]!.split(",").map((s) => s.trim());
    expect(captured).toContain("item");
  });

  it("handles both session.started and step.started handlers", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async () => {\n      const sessionVal = "s";\n      return {\n        s_tool: defineTool({ description: "S", inputSchema: {}, execute() { return sessionVal; } }),\n      };\n    },\n    "beforeModel": async () => {\n      const stepVal = "p";\n      return {\n        p_tool: defineTool({ description: "P", inputSchema: {}, execute() { return stepVal; } }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/multi-event.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    // Should have at least 2 unique hoisted functions
    const matches = code.match(/__eve_dynamic_exec_\d+/g) ?? [];
    const unique = new Set(matches);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("the dynamic-ctx fixture pattern works end-to-end", async () => {
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (event, ctx) => {\n      const resolverSessionId = ctx.session.id;\n\n      return {\n        check_ctx: defineTool({\n          description: "Check",\n          inputSchema: { type: "object" },\n          execute(_input, executeCtx) {\n            return {\n              resolverSessionId,\n              executeCtxType: typeof executeCtx,\n            };\n          },\n        }),\n      };\n    },\n  },\n});\n';

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
    const source =
      '\nimport { defineDynamic, defineTool } from "eve/tools";\n\nexport default defineDynamic({\n  events: {\n    "beforeSession": async (_input, ctx) => {\n      const tag = "typed";\n      return {\n        tool: defineTool({\n          description: "T",\n          inputSchema: { type: "object" },\n          execute(_input: Record<string, unknown>, ctx: import("eve/tools").ToolContext) {\n            return { tag, input: _input, hasCtx: ctx !== undefined };\n          },\n        }),\n      };\n    },\n  },\n});\n';

    const result = await transformDynamicToolExecute("tools/generic-params.ts", source);
    expect(result).not.toBeNull();
    const code = result!.code;

    expect(code).toMatch(/function __eve_dynamic_exec_\d+\(\{ tag \}, _input/);
    expect(code).toMatch(/\(\.\.\.__args\) => __eve_dynamic_exec_\d+\(\{ tag \}, \.\.\.__args\)/);
  });
});

describe("durable schema expression transform", () => {
  it("captures inline refinement values separately from the current resolver invocation", async () => {
    const { callHandler } = await transformAndEval(
      "schema.ts",
      '\n      import { defineTool, defineDynamic } from "eve/tools";\n      import { z } from "zod";\n      const output = z.object({ value: z.string().trim() });\n      export default defineDynamic({ events: { "beforeSession": (_event, ctx) => {\n        const limit = ctx.limit;\n        return { checked: defineTool({\n          description: "Checked",\n          inputSchema: z.object({ amount: z.number().refine(value => value <= limit) }),\n          outputSchema: output,\n          execute: () => limit,\n        }) };\n      } } });\n    ',
      { ctx: { limit: 10 } },
    );
    const entry = (await callHandler()).checked;
    const callbacks = durableCallbacks(entry);
    expect(callbacks.inputSchema!.closure).toEqual({ limit: 10 });
    expect(callbacks.outputSchema!.closure).toEqual({});
    const schema = callbacks.inputSchema!.callback({ limit: 5 });
    if (!isToolSchema(schema)) throw new Error("Expected schema");
    expect(await schema["~standard"].validate({ amount: 6 })).toHaveProperty("issues");
    expect(await schema["~standard"].validate({ amount: 4 })).toEqual({ value: { amount: 4 } });
    const output = callbacks.outputSchema!.callback({});
    if (!isToolSchema(output)) throw new Error("Expected output schema");
    expect(await output["~standard"].validate({ value: " a " })).toEqual({ value: { value: "a" } });
  });

  it("does not wrap explicit durable schema factories again", async () => {
    const result = await transformDynamicToolExecute(
      "schema.ts",
      `
      import { defineTool, defineDurableSchema as durable } from "eve/tools";
      import { z } from "zod";
      export function tool(limit) {
        return defineTool({ inputSchema: durable({ closure: { limit }, schema: ({ limit }) => z.number().max(limit) }), execute: () => null });
      }
    `,
    );
    expect(result!.code).not.toContain("__eveDefineDurableSchema");
  });
});
