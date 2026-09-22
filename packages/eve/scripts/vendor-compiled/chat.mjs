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
 * 1. The sibling `jsx-runtime-<hash>.d.ts` chunk is co-copied so chat's
 *    relative import resolves locally. The chunk's filename has a content
 *    hash, so we discover it dynamically.
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
    discoverExtraFiles: (distEntries) =>
      // Co-copy the sibling content-hashed declaration chunks the upstream
      // build emits that the entry .d.ts imports by relative path:
      // `jsx-runtime-<hash>.d.ts` (pre-existing) and `messages-<hash>.d.ts`
      // (previously missed — its absence with skipLibCheck:false produced
      // TS2307 across ~120 chat exports, see #1500). The hash suffix is
      // content-derived and drifts on every upstream build.
      distEntries.filter((name) =>
        /^(jsx-runtime|messages)-[^./]+\.d\.ts$/.test(name),
      ),
  }),
};
