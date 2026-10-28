import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { findStrippedReferences } from "./public-exports.mjs";

const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");

function check(files, entry = "/virtual/index.ts") {
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = (name) => files[name];
  host.fileExists = (name) => read(name) !== undefined || ts.sys.fileExists(name);
  host.readFile = (name) => read(name) ?? ts.sys.readFile(name);
  host.directoryExists = (name) => name === "/virtual" || ts.sys.directoryExists(name);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, version, ...rest) =>
    read(name) === undefined
      ? getSourceFile(name, version, ...rest)
      : ts.createSourceFile(name, read(name), version, true);
  const program = ts.createProgram(Object.keys(files), options, host);
  const issues = findStrippedReferences(
    program.getTypeChecker(),
    program,
    new Map([["eve/test", entry]]),
    new Set(Object.keys(files)),
  );
  return issues.map(({ file, message }) => `${file.replace(/^.*\/virtual\//, "")}: ${message}`);
}

test("reports kept declarations that name a stripped one", () => {
  const issues = check({
    "/virtual/hidden.ts": `
      /** @internal */
      export interface Hidden { readonly value: string }
      export interface Shape {
        /** @internal */
        readonly secret?: string;
        readonly open: string;
      }
    `,
    "/virtual/index.ts": `
      import type { Hidden, Shape } from "./hidden.js";
      export { type Hidden } from "./hidden.js";
      export interface Named { readonly hidden: Hidden }
      export type Secret = Shape["secret"];
      declare function make(): Hidden;
      export const inferred = make();
    `,
  });
  assert.equal(issues.length, 4, issues.join("\n"));
  assert.equal(issues.filter((issue) => issue.includes("names Hidden")).length, 3);
  assert.equal(issues.filter((issue) => issue.includes("names secret")).length, 1);
});

test("ignores stripped names that only stripped declarations or code bodies use", () => {
  const issues = check({
    "/virtual/index.ts": `
      /** @internal */
      interface Hidden { readonly value: string }
      export interface Shape {
        /** @internal */
        readonly hidden?: Hidden;
        readonly open: string;
      }
      /** @internal */
      export function hiddenHelper(input: Hidden): Hidden { return input; }
      export function visible(): string {
        const local: Hidden = { value: "x" };
        return local.value;
      }
      export class Box {
        private readonly cache: Hidden | undefined;
        #store: Hidden | undefined;
      }
    `,
  });
  assert.deepEqual(issues, []);
});

test("reports a stripped declaration an entry re-exports through export *", () => {
  const issues = check({
    "/virtual/hidden.ts": `
      /** @internal Shared with tests only. */
      export const hiddenValue = 1;
      export const openValue = 2;
    `,
    "/virtual/index.ts": `export * from "./hidden.js";`,
  });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^hidden\.ts: is exported from eve\/test but tagged @internal/);
});
