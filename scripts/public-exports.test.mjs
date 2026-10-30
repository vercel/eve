import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { findInternalExports } from "./public-exports.mjs";

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
  const issues = findInternalExports(
    program.getTypeChecker(),
    program,
    new Map([["eve/test", entry]]),
    new Set(Object.keys(files)),
  );
  return issues.map(({ file, message }) => `${file.replace(/^.*\/virtual\//, "")}: ${message}`);
}

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
  assert.match(
    issues[0],
    /^hidden\.ts: hiddenValue is exported from eve\/test but tagged @internal/,
  );
});

test("reports a stripped declaration an entry re-exports by name", () => {
  const issues = check({
    "/virtual/hidden.ts": `
      /** @internal */
      export interface Hidden { readonly value: string }
    `,
    "/virtual/index.ts": `export { type Hidden } from "./hidden.js";`,
  });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /^hidden\.ts: Hidden is exported from eve\/test/);
});

test("ignores exports that keep at least one declaration", () => {
  const issues = check({
    "/virtual/hidden.ts": `
      /** @internal */
      export function hiddenHelper(input: string): string { return input; }
    `,
    "/virtual/index.ts": `
      import { hiddenHelper } from "./hidden.js";
      export interface Shape {
        /** @internal */
        readonly hidden?: string;
        readonly open: string;
      }
      export function overloaded(input: string): string;
      /** @internal */
      export function overloaded(input: number): string;
      export function overloaded(input: string | number): string {
        return hiddenHelper(String(input));
      }
    `,
  });
  assert.deepEqual(issues, []);
});

test("reports an export whose every overload is stripped", () => {
  const issues = check({
    "/virtual/index.ts": `
      /** @internal */
      export function hidden(input: string): string;
      /** @internal */
      export function hidden(input: number): string;
      export function hidden(input: string | number): string { return String(input); }
    `,
  });
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /hidden is exported from eve\/test/);
});
