import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const runFile = promisify(execFile);
const createDirectory = useTemporaryDirectories();

// Reports how each import settles, so runs with and without the hook compare.
const ENTRY = `
const results = {};
for (const [name, specifier] of [
  ["mapped", "#internal/module.js"],
  ["relative", "./internal/module.js"],
  ["missing", "#internal/missing.js"],
  ["directory", "#internal/folder.js"],
]) {
  try {
    const module = await import(specifier);
    results[name] = { format: module.format };
  } catch (error) {
    results[name] = { code: error.code };
  }
}
console.log(JSON.stringify(results));
`;

/** An installed eve package with the built hook, as Node loads it from dist. */
async function packageWithHook(): Promise<string> {
  const root = await createDirectory("eve-package-imports-hook-");
  const internal = join(root, "dist", "src", "internal");
  await mkdir(join(internal, "folder.js"), { recursive: true });
  for (const name of ["package-imports", "package-imports-hook"]) {
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
    await writeFile(join(internal, `${name}.js`), stripTypeScriptTypes(source));
  }
  await writeFile(
    join(internal, "module.js"),
    'export const format = typeof require === "undefined" ? "module" : "commonjs";\n',
  );
  await writeFile(join(root, "dist", "src", "entry.js"), ENTRY);
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { readonly imports: unknown };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "eve", type: "module", imports: manifest.imports }),
  );
  return root;
}

async function importResults(root: string, hook: boolean): Promise<unknown> {
  const { stdout } = await runFile(
    process.execPath,
    [
      ...(hook
        ? ["--import", join(root, "dist", "src", "internal", "package-imports-hook.js")]
        : []),
      join(root, "dist", "src", "entry.js"),
    ],
    { cwd: root },
  );
  return JSON.parse(stdout);
}

describe("package imports hook", () => {
  it("resolves eve's imports as Node does, including its errors", async () => {
    const root = await packageWithHook();

    const withHook = await importResults(root, true);

    expect(withHook).toEqual({
      directory: { code: "ERR_UNSUPPORTED_DIR_IMPORT" },
      mapped: { format: "module" },
      missing: { code: "ERR_MODULE_NOT_FOUND" },
      relative: { format: "module" },
    });
    expect(withHook).toEqual(await importResults(root, false));
  });
});
