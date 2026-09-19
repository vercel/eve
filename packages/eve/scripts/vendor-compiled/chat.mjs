import {
  buildOpaqueTypesStub,
  buildUniqueSymbolStub,
  createDeclarationCopier,
} from "./_shared.mjs";

/**
 * Type declarations for `chat` are copied verbatim from the installed
 * package at vendor time. The chat surface (Thread, Message, Author,
 * SentMessage, …) is reachable by consumer code as `ctx.thread.refresh()`
 * etc., so the public type contract has to be the *actual* chat shape —
 * hand-written stubs would drift on every version bump.
 *
 * Three transforms apply during the copy:
 *
 * 1. Sibling declaration chunks are copied with the entrypoint so relative
 *    imports resolve locally. Chunk filenames have content hashes, so we
 *    discover them dynamically and apply the same import rewrites.
 * 2. `from '@workflow/serde'` is rewritten to a local stub that declares
 *    just the unique symbols chat references.
 * 3. `from 'mdast'` is rewritten to a local stub that aliases the names
 *    chat references to `unknown` — consumers don't need @types/mdast.
 */
export default {
  packageName: "chat",
  compiledPath: "chat",
  copyDeclarations: createDeclarationCopier({
    rewrites: {
      "@workflow/serde": {
        kind: "stub",
        stubBaseName: "_workflow-serde",
        build: buildUniqueSymbolStub,
      },
      mdast: {
        kind: "stub",
        stubBaseName: "_mdast",
        build: buildOpaqueTypesStub,
      },
    },
    files: ({ distEntries }) =>
      distEntries
        .filter((name) => name.endsWith(".d.ts"))
        .map((name) => ({ source: name, output: name })),
  }),
};
