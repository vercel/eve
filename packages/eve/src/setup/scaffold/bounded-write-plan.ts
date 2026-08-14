import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

export interface PlannedFileWrite {
  bytes: Buffer;
  destination: string;
  root: string;
  expectedBefore: Buffer | undefined;
  mode?: number;
}

export interface AppliedFileWrite extends PlannedFileWrite {
  appliedMode?: number;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

async function readRegularFile(path: string): Promise<{ bytes: Buffer; mode: number } | undefined> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isFile()) throw new Error(`Refusing to edit non-regular path "${path}".`);
  return { bytes: await readFile(path), mode: metadata.mode };
}

async function assertSafeParents(root: string, destination: string): Promise<void> {
  if (!isWithin(root, destination)) throw new Error(`Refusing to write outside "${root}".`);
  let current = dirname(destination);
  while (isWithin(root, current) && current !== dirname(current)) {
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata?.isSymbolicLink()) throw new Error(`Refusing to traverse symlink "${current}".`);
    if (metadata !== undefined && !metadata.isDirectory()) {
      throw new Error(`Refusing to traverse non-directory path "${current}".`);
    }
    if (current === root) break;
    current = dirname(current);
  }
}

function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

export async function planFileWrite(input: {
  bytes: Buffer;
  destination: string;
  root: string;
  mode?: number;
}): Promise<PlannedFileWrite> {
  const root = resolve(input.root);
  const destination = resolve(input.destination);
  await assertSafeParents(root, destination);
  const existing = await readRegularFile(destination);
  return {
    bytes: input.bytes,
    destination,
    root,
    expectedBefore: existing?.bytes,
    mode: existing?.mode ?? input.mode,
  };
}

export async function applyFileWritePlan(
  root: string,
  writes: readonly PlannedFileWrite[],
): Promise<readonly AppliedFileWrite[]> {
  resolve(root);
  const applied: AppliedFileWrite[] = [];
  try {
    for (const write of writes) {
      await assertSafeParents(write.root, write.destination);
      const before = await readRegularFile(write.destination);
      if (!sameBytes(write.expectedBefore, before?.bytes)) {
        throw new Error(`Refusing to overwrite changed path "${write.destination}".`);
      }
      await mkdir(dirname(write.destination), { recursive: true });
      const temporary = resolve(
        dirname(write.destination),
        `.${basename(write.destination)}.eve-${process.pid}-${applied.length}.tmp`,
      );
      await writeFile(temporary, write.bytes, { flag: "wx", mode: write.mode });
      if (write.mode !== undefined) await chmod(temporary, write.mode);
      await rename(temporary, write.destination).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
      applied.push({ ...write, appliedMode: write.mode });
    }
    return applied;
  } catch (error) {
    const conflicts = await rollbackFileWrites(applied);
    if (conflicts.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nRollback preserved changed paths:\n${conflicts.map((path) => `  - ${path}`).join("\n")}`,
      );
    }
    throw error;
  }
}

export async function rollbackFileWrites(
  writes: readonly AppliedFileWrite[],
): Promise<readonly string[]> {
  const conflicts: string[] = [];
  for (const write of [...writes].reverse()) {
    const current = await readRegularFile(write.destination).catch(() => undefined);
    if (!sameBytes(write.bytes, current?.bytes)) {
      conflicts.push(write.destination);
      continue;
    }
    if (write.expectedBefore === undefined) {
      await rm(write.destination);
      continue;
    }
    const temporary = `${write.destination}.eve-rollback-${process.pid}`;
    await writeFile(temporary, write.expectedBefore, { flag: "wx", mode: write.mode });
    if (write.mode !== undefined) await chmod(temporary, write.mode);
    await rename(temporary, write.destination);
  }
  return conflicts;
}
