import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

const wrapperEntry = fileURLToPath(
  new URL("./entries/@vercel/oidc.mjs", new URL("../", import.meta.url)),
);

const lazyIndexImports = [
  {
    binding: "import_token_util",
    module: "./token-util",
    exports: ["getVercelToken"],
  },
  {
    binding: "import_verify_vercel_oidc_token",
    module: "./verify-vercel-oidc-token",
    exports: ["verifyVercelOidcToken"],
    optional: true,
  },
];

function lazyIndexImport({ binding, module, exports }) {
  const load = `import(${JSON.stringify(`${module}.js`)})`;
  const members = exports.map(
    (name) => `${name}: async (...args) => (await ${load}).${name}(...args)`,
  );
  return `var ${binding} = { ${members.join(", ")} };`;
}

const lazyVercelOidcIndexPlugin = {
  name: "eve-lazy-vercel-oidc-index",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/@vercel/oidc/dist/index.js")) {
      return undefined;
    }

    let code = source;
    for (const entry of lazyIndexImports) {
      const eager = `var ${entry.binding} = require(${JSON.stringify(entry.module)});`;
      if (!code.includes(eager)) {
        if (entry.optional) continue;
        throw new Error(`Failed to find ${entry.module} in the @vercel/oidc index at ${id}.`);
      }
      code = code.replace(eager, lazyIndexImport(entry));
    }
    return { code, map: null };
  },
};

export default {
  packageName: "@vercel/oidc",
  compiledPath: "@vercel/oidc",
  plugins: [lazyVercelOidcIndexPlugin],
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@vercel/oidc.d.ts"),
    },
  ],
};
