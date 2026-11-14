import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gmu;

/** Value imports only: type-only imports and specifier lists are erased at build. */
function staticImports(file: string): string[] {
  const imports: string[] = [];
  for (const [, typeOnly, clause = "", from, sideEffect] of readFileSync(file, "utf8").matchAll(
    STATIC_IMPORT,
  )) {
    if (typeOnly !== undefined) continue;
    const named = /^\{([^}]*)\}$/su.exec(clause.trim())?.[1];
    const specifiers = named?.split(",").map((specifier) => specifier.trim()) ?? [];
    if (named !== undefined && specifiers.filter(Boolean).every((s) => s.startsWith("type "))) {
      continue;
    }
    imports.push((from ?? sideEffect)!);
  }
  return imports;
}

/** Every module the file reaches through static value imports, relative to src or bare. */
function staticGraph(entry: string): Set<string> {
  const reached = new Set<string>();
  const pending = [join(SOURCE_ROOT, entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    // Ids use `/` on every platform so they compare with the paths below.
    const id = file.startsWith(SOURCE_ROOT)
      ? relative(SOURCE_ROOT, file).split(sep).join("/")
      : file;
    if (reached.has(id)) continue;
    reached.add(id);
    if (!file.endsWith(".ts") || !existsSync(file)) continue;
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier).replace(/\.js$/u, ".ts"));
      } else if (specifier.startsWith("#") && !specifier.startsWith("#compiled/")) {
        pending.push(join(SOURCE_ROOT, specifier.slice(1)).replace(/\.js$/u, ".ts"));
      } else {
        pending.push(specifier);
      }
    }
  }
  return reached;
}

const FULL_TUI = ["cli/dev/tui/runner.ts", "client/index.ts", "ai"];

// `eve dev` paints its prompt from startup.ts before the rest of the TUI loads,
// so one new import here would put the runner and its dependencies back on the
// prompt's path.
describe("the eve dev startup prompt's module graph", () => {
  it("stays clear of the full TUI and the model SDK", () => {
    const graph = staticGraph("cli/dev/tui/startup.ts");

    expect(graph.has("cli/dev/tui/terminal-renderer.ts")).toBe(true);
    expect(
      [...graph].filter((id) => FULL_TUI.includes(id) || id === "zod" || id.includes("/zod/")),
    ).toEqual([]);
  });

  it("keeps the full TUI out of the eve dev command itself", () => {
    const graph = staticGraph("cli/dev/command.ts");

    expect(graph.has("cli/dev/tui/startup.ts")).toBe(false);
    expect([...graph].filter((id) => FULL_TUI.includes(id))).toEqual([]);
  });
});
