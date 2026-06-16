import { vi } from "vitest";

/**
 * Vitest setup that makes unit-tier boundary violations fail loudly.
 */

const INTEGRATION_GUIDANCE =
  "Move this test to `src/**/*.integration.test.ts` or `test/scenarios/*.scenario.test.ts`.";

function createUnitGuardError(operation: string): Error {
  return new Error(
    `Unit tests may not invoke \`${operation}\` because the Tier 0 tier must be hermetic. ${INTEGRATION_GUIDANCE}`,
  );
}

function createThrowingFn(operation: string): (...args: unknown[]) => never {
  return () => {
    throw createUnitGuardError(operation);
  };
}

function createAsyncThrowingFn(operation: string): (...args: unknown[]) => Promise<never> {
  return () => Promise.reject(createUnitGuardError(operation));
}

// ---------------------------------------------------------------------------
// Filesystem writes — intercept via vi.mock so the module namespace replacement
// applies to every file that imports these modules in this worker.
// ---------------------------------------------------------------------------

const FORBIDDEN_FS_PROMISES_OPERATIONS = [
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "lchmod",
  "lchown",
  "link",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
] as const;

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const patched: Record<string, unknown> = { ...original };

  for (const operation of FORBIDDEN_FS_PROMISES_OPERATIONS) {
    patched[operation] = createAsyncThrowingFn(`fs/promises.${operation}`);
  }

  return patched;
});

const FORBIDDEN_FS_OPERATIONS = [...FORBIDDEN_FS_PROMISES_OPERATIONS, "createWriteStream"] as const;

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const patched: Record<string, unknown> = { ...original };

  for (const operation of FORBIDDEN_FS_OPERATIONS) {
    patched[operation] = createThrowingFn(`fs.${operation}`);

    const syncName = `${operation}Sync`;
    if (syncName in original) {
      patched[syncName] = createThrowingFn(`fs.${syncName}`);
    }
  }

  return patched;
});

// ---------------------------------------------------------------------------
// Subprocesses
// ---------------------------------------------------------------------------

const FORBIDDEN_CHILD_PROCESS_OPERATIONS = [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
] as const;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const patched: Record<string, unknown> = { ...original };

  for (const operation of FORBIDDEN_CHILD_PROCESS_OPERATIONS) {
    patched[operation] = createThrowingFn(`child_process.${operation}`);
  }

  return patched;
});

// ---------------------------------------------------------------------------
// process.chdir
// ---------------------------------------------------------------------------

process.chdir = ((..._args: unknown[]): void => {
  throw createUnitGuardError("process.chdir");
}) as typeof process.chdir;

// ---------------------------------------------------------------------------
// Real network `fetch`
// ---------------------------------------------------------------------------

/**
 * Rejects any `fetch` call that reaches the guard. Downstream setup files
 * such as `test/setup/mock-ai-gateway.ts` may install their own wrapper that
 * intercepts specific URLs before falling through to this guard.
 */
globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
  const url = resolveFetchUrl(input);

  throw new Error(
    `Unit tests may not make real network requests. Attempted: ${url}. ${INTEGRATION_GUIDANCE}`,
  );
}) as typeof globalThis.fetch;

function resolveFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) {
    return input.url;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return String(input);
}
