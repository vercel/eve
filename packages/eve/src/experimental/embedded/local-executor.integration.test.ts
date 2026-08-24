import { describe, expect, it, vi } from "vitest";

const compileEmbeddedAgent = vi.hoisted(() => vi.fn());
vi.mock("./compile.js", () => ({ compileEmbeddedAgent }));

import { createEmbeddedLocalExecutor } from "./local-executor.js";

describe("embedded local executor lifecycle", () => {
  it("rejects a concurrent executor and releases its lock after initialization fails", async () => {
    const initialization = Promise.withResolvers<never>();
    compileEmbeddedAgent.mockReturnValueOnce(initialization.promise);

    const first = createEmbeddedLocalExecutor({ appRoot: process.cwd(), entrypoint: "agent.ts" });
    const firstRejection = expect(first).rejects.toThrow("compile failed");
    await vi.waitFor(() => expect(compileEmbeddedAgent).toHaveBeenCalledTimes(1));

    await expect(
      createEmbeddedLocalExecutor({ appRoot: process.cwd(), entrypoint: "agent.ts" }),
    ).rejects.toMatchObject({ code: "embedded_executor_already_running" });

    initialization.reject(new Error("compile failed"));
    await firstRejection;

    compileEmbeddedAgent.mockRejectedValueOnce(new Error("second compile failed"));
    await expect(
      createEmbeddedLocalExecutor({ appRoot: process.cwd(), entrypoint: "agent.ts" }),
    ).rejects.toThrow("second compile failed");
  });
});
