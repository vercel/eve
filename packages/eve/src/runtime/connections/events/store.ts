import { createHash } from "node:crypto";
import {
  MemoryDocumentConflictError,
  type MemoryDocumentBackend,
} from "#public/memory/file/backend.js";
import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { EventBinding } from "#runtime/connections/events/state.js";

const defaultBackend = defaultFileMemoryBackend();
const MAX_BINDINGS = 100;

export function connectionEventStore(
  connection: ResolvedConnectionDefinition,
  owner: {
    principalKey: string;
    executionPrincipal: string;
  },
) {
  const backend: MemoryDocumentBackend = connection.experimental_events?.storage ?? defaultBackend;
  const key = `eve.connection-events.${createHash("sha256")
    .update(
      JSON.stringify([
        connection.instanceId,
        connection.connectionName,
        owner.principalKey,
        owner.executionPrincipal,
      ]),
    )
    .digest("hex")}`;
  const read = async () => {
    const document = await backend.read({ key, signal: AbortSignal.timeout(30_000) });
    const bindings =
      document === null ? {} : (JSON.parse(document.content) as Record<string, EventBinding>);
    return { document, bindings };
  };
  return {
    async list(): Promise<Record<string, EventBinding>> {
      return (await read()).bindings;
    },
    async save(binding: EventBinding): Promise<EventBinding> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const { document, bindings } = await read();
        const existing = bindings[binding.id];
        if (existing === undefined && Object.keys(bindings).length >= MAX_BINDINGS)
          throw new Error(
            `A caller can create at most ${MAX_BINDINGS} event bindings per connection.`,
          );
        const saved: EventBinding = {
          ...binding,
          retired: binding.retired === true || existing?.retired === true ? true : undefined,
          terminationDeliveryId: existing?.terminationDeliveryId ?? binding.terminationDeliveryId,
        };
        try {
          await backend.write({
            key,
            signal: AbortSignal.timeout(30_000),
            expectedVersion: document?.version ?? null,
            content: JSON.stringify({ ...bindings, [binding.id]: saved }),
          });
          return saved;
        } catch (error) {
          if (!MemoryDocumentConflictError.is(error)) throw error;
        }
      }
      throw new Error("Event subscription registry remained busy. Retry the operation.");
    },
  };
}
