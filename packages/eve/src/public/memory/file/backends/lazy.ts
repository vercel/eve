import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";

export function lazyBackend(resolve: () => MemoryDocumentBackend): MemoryDocumentBackend {
  let backend: MemoryDocumentBackend | undefined;
  const get = () => (backend ??= resolve());
  return {
    read: (input) => get().read(input),
    write: (input) => get().write(input),
  };
}
