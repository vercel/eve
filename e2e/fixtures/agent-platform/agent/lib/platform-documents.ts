import { inMemory, type MemoryDocumentBackend } from "eve/memory/file";

export interface PlatformLedger {
  readonly note: string;
  writes: number;
}

declare global {
  var __agentPlatformLedger: PlatformLedger | undefined;
}

export function platformLedger(): PlatformLedger | undefined {
  return globalThis.__agentPlatformLedger;
}

export function platformDocuments(note: string): MemoryDocumentBackend {
  const documents = inMemory();
  const ledger: PlatformLedger = { note, writes: 0 };
  globalThis.__agentPlatformLedger = ledger;
  return {
    read: (input) => documents.read(input),
    async write(input) {
      const written = await documents.write(input);
      ledger.writes += 1;
      return written;
    },
  };
}
