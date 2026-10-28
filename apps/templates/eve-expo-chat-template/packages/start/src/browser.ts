import browser from "@agent-browser/eve";
import * as tools from "@agent-browser/eve/tools";
import type { ToolContext, ToolDefinition } from "eve/tools";
import { parse } from "shell-quote";
import { computerRequest } from "./computer.ts";
browser({
  autoInstall: false,
  inlineScreenshots: false,
  contentBoundaries: true,
  maxOutputChars: 50000,
  sessionPrefix: "eve-start",
});
export function browserTool(
  name: keyof typeof tools,
  request = computerRequest,
): ToolDefinition<unknown, unknown> {
  const definition = tools[name] as ToolDefinition<unknown, unknown>;
  return {
    ...definition,
    execute: async (input, ctx) => {
      const context = new Proxy(ctx, {
        get(target, key) {
          if (key !== "getSandbox") return Reflect.get(target, key);
          return async () => ({
            run: async ({ command }: { command: string }) => {
              ctx.abortSignal?.throwIfAborted();
              const parsed = parse(command, (variable) => {
                throw Error(`Shell variable expansion is not supported: ${variable}`);
              });
              if (parsed[0] !== "agent-browser" || parsed.some((arg) => typeof arg !== "string"))
                throw Error("Only agent-browser commands are supported");
              const result = await request<{ result?: unknown }>("agent/browser/execute", {
                type: "agent-browser",
                args: parsed.slice(1) as string[],
              });
              return result.result;
            },
          });
        },
      }) as ToolContext;
      return definition.execute!(input, context);
    },
  };
}
