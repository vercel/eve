import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  DUCKDB_PATH,
  DUCKDB_VERSION,
  MIRROR_DATABASE_PATH,
  buildMirrorDatabase,
  installDuckdb,
  mirrorBuildSql,
  mirrorViewsSql,
} from "./database";
import type { DatabaseSandbox } from "./database";

const binary = new TextEncoder().encode("#!/bin/sh\necho fake duckdb\n");
const compressed = gzipSync(binary);
const assets = {
  x86_64: {
    sha256: createHash("sha256").update(compressed).digest("hex"),
    url: "https://example.com/duckdb.gz",
  },
};

/* Command result with the given exit code and standard output. */
const result = (exitCode: number, stdout = "") => ({
  exitCode,
  stderr: () => Promise.resolve(exitCode ? "failed" : ""),
  stdout: () => Promise.resolve(stdout),
});

/*
 * Fake sandbox: `--version` reports the pinned version only once the binary is written.
 * Like Vercel Sandbox, it rejects a binary it cannot start instead of returning an exit code.
 */
const fakeSandbox = (
  options: { arch?: string; installed?: boolean; runs?: boolean } = {}
) => {
  const { arch = "x86_64", runs = true } = options;
  let installed = options.installed ?? false;
  const commands: string[][] = [];
  const written: {
    content: string | Uint8Array;
    mode?: number;
    path: string;
  }[] = [];
  const sandbox: DatabaseSandbox = {
    runCommand: vi.fn((command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (command === DUCKDB_PATH && args[0] === "--version") {
        return installed && runs
          ? Promise.resolve(
              result(0, `v${DUCKDB_VERSION} (Variegata) 069cc9f9b5\n`)
            )
          : Promise.reject(
              new Error(
                `Status code 400 is not ok: fork/exec ${DUCKDB_PATH}: no such file or directory`
              )
            );
      }
      if (command === "uname") {
        return Promise.resolve(result(0, `${arch}\n`));
      }
      if (command === "mv" && args.at(-1) === DUCKDB_PATH) {
        installed = true;
      }
      return Promise.resolve(result(0));
    }),
    writeFiles: vi.fn((files) => {
      written.push(...files);
      return Promise.resolve();
    }),
  };
  return { commands, sandbox, written };
};

const download = vi.fn<typeof fetch>(() =>
  Promise.resolve(new Response(compressed))
);

describe("mirror database SQL", () => {
  it("ships the generated views as the search_content skill's views.sql", () => {
    const shipped = readFileSync(
      fileURLToPath(
        new URL(
          "../../../skills/search_content/scripts/views.sql",
          import.meta.url
        )
      ),
      "utf-8"
    );
    expect(shipped).toBe(mirrorViewsSql("/contentful"));
  });

  it("materializes every view into the target with bounded memory", () => {
    const sql = mirrorBuildSql("/contentful/.next.duckdb");
    expect(sql).toContain("SET preserve_insertion_order = false;");
    expect(sql).toContain("ATTACH '/contentful/.next.duckdb' AS mirror;");
    for (const table of [
      "entries",
      "refs",
      "pages",
      "content_types",
      "type_fields",
      "users",
    ]) {
      expect(sql).toContain(`CREATE TABLE mirror.${table} AS FROM ${table};`);
    }
  });

  it("stores the search macro in the database, binding its tables when called", () => {
    const sql = mirrorBuildSql("/contentful/.next.duckdb");
    const macro = sql.indexOf("CREATE MACRO mirror.search(term) AS TABLE");
    expect(macro).toBeGreaterThan(sql.indexOf("ATTACH"));
    expect(macro).toBeLessThan(sql.indexOf("DETACH mirror;"));
    expect(sql).toContain(
      "CREATE TABLE mirror.search_text AS FROM search_text;"
    );
    expect(sql.slice(macro)).toContain("FROM search_text");
    expect(sql.slice(macro)).not.toContain("mirror.search_text");
    expect(mirrorViewsSql("/contentful")).toContain(
      "CREATE MACRO search(term) AS TABLE"
    );
  });
});

describe("installDuckdb", () => {
  it("does nothing when the pinned version is already on the Drive", async () => {
    const { sandbox, written } = fakeSandbox({ installed: true });
    await installDuckdb(sandbox, download, assets);
    expect(download).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("downloads, verifies, unpacks, and publishes an executable binary", async () => {
    const { commands, sandbox, written } = fakeSandbox();
    await installDuckdb(sandbox, download, assets);
    expect(download).toHaveBeenCalledWith("https://example.com/duckdb.gz", {
      signal: expect.any(AbortSignal),
    });
    expect(written).toEqual([
      { content: Buffer.from(binary), mode: 0o755, path: `${DUCKDB_PATH}.tmp` },
    ]);
    expect(commands).toContainEqual([
      "mv",
      "-f",
      "--",
      `${DUCKDB_PATH}.tmp`,
      DUCKDB_PATH,
    ]);
  });

  it("rejects a download whose checksum does not match", async () => {
    const { sandbox, written } = fakeSandbox();
    const tampered = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(gzipSync(new TextEncoder().encode("evil"))))
    );
    await expect(installDuckdb(sandbox, tampered, assets)).rejects.toThrow(
      "checksum mismatch"
    );
    expect(written).toEqual([]);
  });

  it("fails when the download times out", async () => {
    const { sandbox, written } = fakeSandbox();
    const stalled = vi.fn<typeof fetch>(() =>
      Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError")
      )
    );
    await expect(installDuckdb(sandbox, stalled, assets)).rejects.toThrow(
      "timed out"
    );
    expect(written).toEqual([]);
  });

  it("rejects unsupported architectures before downloading", async () => {
    const { sandbox } = fakeSandbox({ arch: "riscv64" });
    await expect(installDuckdb(sandbox, download, assets)).rejects.toThrow(
      'architecture "riscv64"'
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("fails when the installed binary cannot run in the sandbox", async () => {
    const { sandbox } = fakeSandbox({ runs: false });
    await expect(installDuckdb(sandbox, download, assets)).rejects.toThrow(
      "does not run"
    );
  });
});

describe("buildMirrorDatabase", () => {
  it("builds beside the final path and swaps the result into place", async () => {
    const { commands, sandbox } = fakeSandbox({ installed: true });
    await buildMirrorDatabase(sandbox, download);
    const build = commands.findIndex(
      ([command, flag]) => command === DUCKDB_PATH && flag === "-c"
    );
    const swap = commands.findIndex(
      (command) =>
        command[0] === "mv" && command.at(-1) === MIRROR_DATABASE_PATH
    );
    expect(build).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(build);
  });
});
