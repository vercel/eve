import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DIAGNOSTICS_WORKER_SOURCE, toolingPaths } from "../../extension/lib/tooling.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptPath = join(
  dirname(require.resolve("typescript-compiler/package.json")),
  "lib/typescript.js",
);
const vettedPath = toolingPaths({ resolvePath: (path) => `/workspace/${path}` }).typescriptModule;

async function workerFixture(root: string, compilerAvailable = true) {
  const worker = join(root, "diagnostics.cjs");
  const preload = join(root, "compiler-fixture.cjs");
  await writeFile(worker, DIAGNOSTICS_WORKER_SOURCE);
  // Map only the fixed production path to our installed test compiler; no root install is needed.
  await writeFile(
    preload,
    `
const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  if (id === ${JSON.stringify(vettedPath)}) {
    if (!${compilerAvailable}) throw new Error("trusted compiler unavailable");
    return ${JSON.stringify(typescriptPath)};
  }
  return resolve.call(this, id, ...args);
};
`,
  );
  return async (filePath: string, requestedCompiler = typescriptPath) => {
    const request = Buffer.from(
      JSON.stringify({ repoRoot: root, filePath, typescriptPath: requestedCompiler }),
    ).toString("base64");
    const { stdout } = await execFileAsync(process.execPath, ["--require", preload, worker], {
      cwd: root,
      env: { EVE_CODE_DIAGNOSTICS_REQUEST: request },
    });
    return JSON.parse(stdout) as {
      diagnostics: { code: number; column: number; line: number; message: string }[];
    };
  };
}

test("reports TypeScript diagnostics through the sandbox worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-diagnostics-"));
  try {
    const runWorker = await workerFixture(root);
    await Promise.all([
      writeFile(join(root, "package.json"), '{"type":"module"}\n'),
      writeFile(
        join(root, "tsconfig.json"),
        '{"compilerOptions":{"strict":true,"target":"esnext"},"include":["*.ts"]}\n',
      ),
      writeFile(join(root, "file.ts"), 'const value: number = "wrong";\n'),
    ]);

    const result = await runWorker("file.ts");

    assert.equal(result.diagnostics[0]?.code, 2322);
    assert.equal(result.diagnostics[0]?.line, 1);
    assert.match(result.diagnostics[0]?.message ?? "", /string.*number/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

for (const compilerAvailable of [true, false]) {
  test(`never executes repository or request-supplied compilers (trusted compiler available: ${compilerAvailable})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-code-hostile-compiler-"));
    try {
      const runWorker = await workerFixture(root, compilerAvailable);
      const maliciousCompiler = join(root, "node_modules/typescript");
      const marker = join(root, "compiler-executed");
      await mkdir(maliciousCompiler, { recursive: true });
      await Promise.all([
        writeFile(join(root, "package.json"), "{}"),
        writeFile(join(root, "file.ts"), 'const value: number = "wrong";\n'),
        writeFile(join(maliciousCompiler, "package.json"), '{"main":"index.cjs"}'),
        writeFile(
          join(maliciousCompiler, "index.cjs"),
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); throw new Error("malicious compiler ran");`,
        ),
      ]);
      for (const requestedCompiler of [typescriptPath, maliciousCompiler]) {
        if (compilerAvailable) {
          const result = await runWorker("file.ts", requestedCompiler);
          assert.equal(result.diagnostics[0]?.code, 2322);
          assert.equal(result.diagnostics[0]?.column, 7);
        } else {
          await assert.rejects(
            runWorker("file.ts", requestedCompiler),
            /trusted compiler unavailable/u,
          );
        }
        await assert.rejects(access(marker), { code: "ENOENT" });
      }
      if (compilerAvailable) {
        await writeFile(join(root, "file.ts"), "const value: number = 1;\n");
        assert.deepEqual((await runWorker("file.ts", maliciousCompiler)).diagnostics, []);
      }
      await assert.rejects(access(marker), { code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}

test("uses the nearest project config, includes edited files, and preserves syntax diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-project-diagnostics-"));
  try {
    const runWorker = await workerFixture(root);
    await mkdir(join(root, "nested"));
    await Promise.all([
      writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strictNullChecks":false}}'),
      writeFile(
        join(root, "nested/tsconfig.json"),
        '{"compilerOptions":{"strictNullChecks":true},"files":[]}',
      ),
      writeFile(join(root, "nested/file.ts"), "const value: number = null;\n"),
    ]);
    assert.equal((await runWorker("nested/file.ts")).diagnostics[0]?.code, 2322);
    await writeFile(join(root, "nested/file.ts"), "const value = ;\n");
    assert.equal((await runWorker("nested/file.ts")).diagnostics[0]?.code, 1109);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
