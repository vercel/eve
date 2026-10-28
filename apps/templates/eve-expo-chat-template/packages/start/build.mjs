import "./build-assets.mjs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL(".", import.meta.url));

execFileSync(process.execPath, ["../../node_modules/eve/bin/eve.js", "extension", "build"], {
  cwd,
  stdio: "inherit",
});
await build({
  entryPoints: [cwd + "src/relay-client.ts"],
  bundle: true,
  outfile: cwd + "dist/client.js",
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["zod"],
});
execFileSync(
  process.execPath,
  [
    "../../node_modules/typescript/bin/tsc",
    "--declaration",
    "--emitDeclarationOnly",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--target",
    "es2023",
    "--allowImportingTsExtensions",
    "--rewriteRelativeImportExtensions",
    "--skipLibCheck",
    "--outDir",
    "dist/client-types",
    "src/relay-client.ts",
    "src/relay-protocol.ts",
  ],
  { cwd, stdio: "inherit" },
);

await build({
  entryPoints: [cwd + "src/provision.ts"],
  bundle: true,
  outfile: cwd + "dist/provision.js",
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@vercel/sandbox", "postgres"],
});

await build({
  entryPoints: [cwd + "src/deploy.ts"],
  bundle: true,
  outfile: cwd + "dist/deploy.js",
  platform: "node",
  format: "esm",
  target: "node24",
});
