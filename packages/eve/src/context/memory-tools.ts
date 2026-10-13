import type { MemoryDefinition, MemoryScope, MemoryToolsContext } from "#public/memory/index.js";
import {
  asFrameworkDefinition,
  defineDynamic,
  type RecordContext,
  type SelectContext,
} from "#dynamic/definition.js";
import { principalOf, resolveMemoryScope } from "#reactions/kinds/memory.js";
import { frameworkRecordContext, type InternalRecordContext } from "#reactions/reaction.js";
import { isBrandedToolEntry } from "#tools/dynamic.js";

/** A memory slot's provider tools, as a dynamic tool resolver named `<slot>__<key>`. */
export function createMemoryToolDynamicDefinition(definition: MemoryDefinition, slot: string) {
  return asFrameworkDefinition(
    defineDynamic({
      select: (_view: unknown, ctx: SelectContext) => ({
        principal: principalOf(ctx),
        session: ctx.session.id,
      }),
      // The scope is the data the tools are made from, and the session records it.
      record: async (_selected: unknown, resolveContext: RecordContext) => {
        if (definition.provider.tools === undefined) return null;
        return resolveMemoryScope({ ...definition, slot }, frameworkRecordContext(resolveContext));
      },
      // The provider builds its tools from the scope, in any process, without resolving it again.
      render: async (scope: MemoryScope | null, resolveContext?: InternalRecordContext) => {
        if (scope === null || definition.provider.tools === undefined) return null;
        const { abortSignal, channel, conversation, session } = resolveContext!;
        const context = {
          abortSignal,
          channel,
          memory: { scope, slot },
          session,
        } as { -readonly [K in keyof MemoryToolsContext]: MemoryToolsContext[K] };
        if (conversation !== undefined) context.conversation = conversation;
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
    } as never),
  );
}
