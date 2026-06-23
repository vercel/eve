import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { defineClientTool } from "#public/definitions/tool.js";
import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";

describe("defineClientTool", () => {
  it("brands the definition and marks it client-resolved with no execute", () => {
    const tool = defineClientTool({
      description: "Ask the user a question.",
      inputSchema: z.object({ prompt: z.string() }),
    });

    expect(isBrandedToolEntry(tool)).toBe(true);
    expect((tool as { clientResolved?: unknown }).clientResolved).toBe(true);
    expect((tool as { execute?: unknown }).execute).toBeUndefined();
    expect(tool.description).toBe("Ask the user a question.");
  });

  it("throws when an execute function is supplied", () => {
    // `execute` is intentionally absent from the client-resolved overloads;
    // cast past the type so the runtime guard itself is exercised.
    const withExecute = {
      description: "Not allowed.",
      inputSchema: z.object({}),
      execute: () => ({ status: "ignored" as const }),
    } as unknown as Parameters<typeof defineClientTool>[0];

    expect(() => defineClientTool(withExecute)).toThrow(/must not define "execute"/);
  });
});
