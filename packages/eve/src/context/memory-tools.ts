import type { MemoryDefinition, MemoryToolsContext } from "#public/memory/index.js";
import { asFrameworkDefinition, defineDynamic } from "#dynamic/definition.js";
import { principalOf, resolveMemoryScope } from "#reactions/kinds/memory.js";
import type { InternalContext } from "#reactions/reaction.js";
import { readReactionsState } from "#reactions/state.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";

/** A memory slot's provider tools, as a dynamic tool resolver named `<slot>__<key>`. */
export function createMemoryToolDynamicDefinition(definition: MemoryDefinition, slot: string) {
  return asFrameworkDefinition(
    defineDynamic(async (ctx: InternalContext) => {
      if (definition.provider.tools === undefined) return null;
      // The scope is the data the tools are made from: resolved once per turn and principal, as
      // recall resolves it, so both read the channel of the same turn.
      const turn = readReactionsState(ctx.ctx).latest["turn.started"] ?? null;
      const scope = await ctx.memo({ principal: principalOf(ctx), turn }, () =>
        resolveMemoryScope({ ...definition, slot }, ctx),
      );
      if (scope === null) return null;
      const context = {
        abortSignal: ctx.abortSignal,
        channel: ctx.channel,
        memory: { scope, slot },
        session: ctx.session,
      } as { -readonly [K in keyof MemoryToolsContext]: MemoryToolsContext[K] };
      if (ctx.conversation !== undefined) context.conversation = ctx.conversation;
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
    }),
  );
}
