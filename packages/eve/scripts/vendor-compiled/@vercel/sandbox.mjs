import {
  createDeclarationCopier,
  createOptionalNativeStubPlugin,
  loadDeclaration,
} from "../_shared.mjs";

/**
 * `@vercel/sandbox` is vendored as a hand-curated adapter (`index.d.ts`)
 * that narrows the SDK to the surface eve wraps and renames a couple of
 * types upstream never exports (`Command` -> `SandboxCommand`, the inline
 * `update` param -> `SandboxUpdateParams`). The adapter intentionally does
 * NOT re-declare the firewall network-policy types.
 *
 * Those types drove a real drift bug: the hand-written copy lagged the
 * SDK's credential-brokering matchers (`match`, `forwardURL`, …). So
 * `network-policy.d.ts` is copied verbatim from the installed package and
 * the adapter re-exports it. The upstream file is self-contained (zero
 * imports), so no rewrite rules are needed — and a future version that
 * adds an import hard-fails the copier instead of silently drifting.
 */
export default {
  packageName: "@vercel/sandbox",
  compiledPath: "@vercel/sandbox",
  plugins: [createOptionalNativeStubPlugin(["fsevents"])],
  declaration: await loadDeclaration("@vercel/sandbox.d.ts"),
  copyDeclarations: createDeclarationCopier({
    files: [{ source: "network-policy.d.ts", output: "network-policy.d.ts" }],
  }),
};
