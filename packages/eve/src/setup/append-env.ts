import { readFile, writeFile } from "node:fs/promises";

interface AppendEnvOptions {
  force?: boolean;
}

interface AppendEnvResult {
  written: string[];
  skipped: string[];
}

export async function appendEnv(
  envPath: string,
  values: Record<string, string>,
  options: AppendEnvOptions = {},
): Promise<AppendEnvResult> {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const lines = existing.split("\n");
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    const matchIndex = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (matchIndex >= 0) {
      if (options.force) {
        lines[matchIndex] = `${key}=${value}`;
        written.push(key);
      } else {
        skipped.push(key);
      }
    } else {
      lines.push(`${key}=${value}`);
      written.push(key);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  await writeFile(envPath, `${lines.join("\n")}\n`, "utf8");

  return { written, skipped };
}
