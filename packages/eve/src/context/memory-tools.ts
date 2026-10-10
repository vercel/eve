import type { MemoryDefinition, MemoryToolsContext } from "#public/memory/index.js";
import { defineDynamic } from "#dynamic/definition.js";
import { principalOf, resolveMemoryScope } from "#reactions/kinds/memory.js";
import type { InternalResolveContext } from "#reactions/reaction.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";

/** A memory slot's provider tools, as a dynamic tool resolver named `<slot>__<key>`. */
export function createMemoryToolDynamicDefinition(definition: MemoryDefinition, slot: string) {
  return defineDynamic({
    select: (_view, ctx) => ({ principal: principalOf(ctx), session: ctx.session.id }),
    resolve: async (_selected, resolveContext) => {
      if (definition.provider.tools === undefined) return null;
      const scope = await resolveMemoryScope(
        { ...definition, slot },
        resolveContext as InternalResolveContext,
      );
      if (scope === null) return null;
      const context: MemoryToolsContext = { ...resolveContext, memory: { scope, slot } };
      const result = await definition.provider.tools(context);
      if (result === null) return null;
      if (typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`Memory slot "${slot}" provider.tools() must return a tool map or null.`);
      }
      return Object.fromEntries(
        Object.entries(result).map(([key, tool]) => {
          const name = `${slot}__${key}`;
          if (!isBrandedToolEntry(tool)) {
            throw new Error(`Memory provider tool "${name}" must be created with defineTool().`);
          }
          const description =
            definition.description === undefined
              ? tool.description
              : `${definition.description}\n\n${tool.description}`;
          return [name, { ...tool, description }];
        }),
      );
    },
  });
}
