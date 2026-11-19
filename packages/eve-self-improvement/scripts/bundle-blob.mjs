import { build } from "esbuild";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
for (const output of [
  "dist/portable/extension/lib/blob-store.js",
  "dist/extension/lib/blob-store.mjs",
]) {
  const extension = output.endsWith(".mjs");
  await build({
    entryPoints: ["extension/lib/blob-store.ts"],
    outfile: `${output}.tmp`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["./config.js", "@vercel/oidc"],
    legalComments: "inline",
    plugins: extension
      ? [
          {
            name: "extension-imports",
            setup(build) {
              build.onResolve({ filter: /^\.\/config\.js$/ }, () => ({
                path: "./config.mjs",
                external: true,
              }));
            },
          },
        ]
      : [],
    banner: {
      js: 'import { createRequire as __blobCreateRequire } from "node:module"; const require = __blobCreateRequire(import.meta.url);',
    },
  });
  await rename(`${output}.tmp`, output);
}

async function packageRoot(name, resolver = require) {
  let directory = dirname(resolver.resolve(name));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate license for ${name}`);
    directory = parent;
  }
}
const blobRoot = await packageRoot("@vercel/blob");
const blobRequire = createRequire(join(blobRoot, "package.json"));
const retryRequire = createRequire(
  join(await packageRoot("async-retry", blobRequire), "package.json"),
);
const licenses = [
  ["@vercel/blob", "license.md", require],
  ["undici", "LICENSE", blobRequire],
  ["undici", "lib/web/fetch/LICENSE", blobRequire],
  ["async-retry", "LICENSE.md", blobRequire],
  ["retry", "License", retryRequire],
  ["is-buffer", "LICENSE", blobRequire],
  ["throttleit", "license", blobRequire],
  ["is-node-process", null, blobRequire],
];
const notices = await Promise.all(
  licenses.map(async ([name, file, resolver]) => {
    const root = await packageRoot(name, resolver);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const text = file
      ? await readFile(join(root, file), "utf8")
      : "The published package declares the MIT license and includes no separate license file.\nSource: https://github.com/mswjs/is-node-process";
    return `${name}@${manifest.version} — ${manifest.license}\n${file ?? "package.json license declaration"}\n\n${text}`;
  }),
);
await writeFile(
  "dist/THIRD_PARTY_LICENSES.txt",
  `Bundled Blob SDK third-party notices\n\n${notices.join("\n\n----------------------------------------\n\n")}\n`,
);
