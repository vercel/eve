import { mkdir, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class WriteFileExistsError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Refusing to overwrite ${path} (pass --force to override).`);
    this.name = "WriteFileExistsError";
    this.path = path;
  }
}

export interface WriteFileOptions {
  force?: boolean;
}

export async function writeTextFile(
  path: string,
  content: string,
  options: WriteFileOptions = {},
): Promise<void> {
  if (!options.force && (await pathExists(path))) {
    throw new WriteFileExistsError(path);
  }
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content, "utf8");
}
