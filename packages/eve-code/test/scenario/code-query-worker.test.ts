import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DIAGNOSTICS_WORKER_SOURCE } from "../../extension/lib/tooling.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptPath = dirname(require.resolve("typescript-compiler/package.json"));

test("reports TypeScript diagnostics through the sandbox worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-diagnostics-"));
  const worker = join(root, "diagnostics.cjs");
  try {
    await Promise.all([
      writeFile(worker, DIAGNOSTICS_WORKER_SOURCE),
      writeFile(join(root, "package.json"), '{"type":"module"}\n'),
      writeFile(
        join(root, "tsconfig.json"),
        '{"compilerOptions":{"strict":true,"target":"esnext"},"include":["*.ts"]}\n',
      ),
      writeFile(join(root, "file.ts"), 'const value: number = "wrong";\n'),
    ]);

    const request = Buffer.from(
      JSON.stringify({ repoRoot: root, filePath: "file.ts", typescriptPath }),
      "utf8",
    ).toString("base64");
    const { stdout } = await execFileAsync(process.execPath, [worker], {
      env: { EVE_CODE_DIAGNOSTICS_REQUEST: request },
    });
    const result = JSON.parse(stdout) as {
      diagnostics: { code: number; line: number; message: string }[];
    };

    assert.equal(result.diagnostics[0]?.code, 2322);
    assert.equal(result.diagnostics[0]?.line, 1);
    assert.match(result.diagnostics[0]?.message ?? "", /string.*number/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
