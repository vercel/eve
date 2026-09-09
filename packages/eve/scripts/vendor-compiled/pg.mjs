import { createOptionalNativeStubPlugin, loadDeclaration } from "./_shared.mjs";

export default {
  packageName: "pg",
  compiledPath: "pg",
  bundling: "standalone",
  declaration: await loadDeclaration("pg.d.ts"),
  entry: "esm/index.mjs",
  plugins: [createOptionalNativeStubPlugin(["pg-native"])],
};
