import {
  type Definition,
  once,
  section,
  type Section,
  SECTION_ORDER,
  type ToolTable,
} from "#definitions/definition.js";
import type { HarnessContext, HarnessTools } from "#public/definitions/harness.js";
import { toolsDefinition } from "#definitions/tools.js";
import { fromPublicTools, harnessContext, partsOf, sectionsOf, toPublicTools } from "./context.js";
import { type HarnessStack, runStage } from "./stack.js";

// The request stages a harness changes, as definitions: `tools` and `instructions` arrange the
// call the definitions before them drafted, after eve's builtins and before its catalog, so a tool
// a harness drops can't be found with `eve__search`. Their value forms are collected like a file's.

/** The definitions a stack adds to its agent's: its layers' tools, then its arrangement. */
export function harnessDefinitions(stack: HarnessStack): readonly Definition[] {
  if (stack.layers.length === 0) return [];
  return [...valueTools(stack), arrangement(stack)];
}

function arrangement(stack: HarnessStack): Definition {
  const added = stack.layers.flatMap(({ definition, label }) =>
    typeof definition.instructions === "string"
      ? [section(label, definition.instructions, { order: SECTION_ORDER.dynamicInstructions + 1 })]
      : [],
  );
  const changes = (stage: "tools" | "instructions") =>
    stack.layers.some((layer) => typeof layer.definition[stage] === "function");
  return {
    contribute: (dctx) => ({
      ...(added.length > 0 && { system: added }),
      arrange: (draft) => {
        // Each stage reads the other through `ctx.harness`, never itself.
        const ctx = (running: "tools" | "instructions"): HarnessContext =>
          harnessContext(
            dctx.container,
            {
              history: dctx.history ?? [],
              ...(dctx.step?.view !== undefined && { view: dctx.step.view().projection.view }),
              system,
              tools,
            },
            running,
          );
        const tools = once(async (): Promise<ToolTable> => {
          const below = await draft.tools();
          if (!changes("tools")) return below;
          const chosen: HarnessTools = await runStage(stack, "tools", ctx("tools"), async () =>
            toPublicTools(below),
          );
          return fromPublicTools(below, chosen, "the harness");
        });
        const system = once(async (): Promise<readonly Section[]> => {
          const below = await draft.system();
          if (!changes("instructions")) return below;
          const parts: readonly string[] = await runStage(
            stack,
            "instructions",
            ctx("instructions"),
            async () => partsOf(below),
          );
          return sectionsOf(below, parts, "eve.harness");
        });
        return { system, tools };
      },
    }),
    id: "eve.harness",
    label: "the agent's harness",
  };
}

/** The tools each layer adds with `tools: { ... }`, named as a tool file in its mount would be. */
function valueTools(stack: HarnessStack): readonly Definition[] {
  return stack.layers.flatMap(({ definition, label, namespace }, index) => {
    const tools = definition.tools;
    if (tools === undefined || typeof tools === "function") return [];
    return [
      toolsDefinition(
        {
          logicalPath: label,
          slug: `harness-${index}`,
          ...(namespace !== undefined && { extensionNamespace: namespace }),
        },
        () => tools,
      ),
    ];
  });
}
