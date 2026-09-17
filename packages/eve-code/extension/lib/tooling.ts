import type { SandboxSession } from "eve/sandbox";

import { GH_SIGNED_COMMIT_SOURCE, GH_SIGNED_COMMIT_VERSION } from "./signed-commit.ts";

export { GH_SIGNED_COMMIT_SOURCE, GH_SIGNED_COMMIT_VERSION };
export const TYPESCRIPT_VERSION = "6.0.3";
const TOOLING_DIR = ".eve-code";

export function toolingPaths(sandbox: Pick<SandboxSession, "resolvePath">) {
  const root = sandbox.resolvePath(TOOLING_DIR);
  const trustedRoot = "/usr/local/lib/eve-code";
  return {
    root,
    trustedRoot,
    env: `${root}/env`,
    ghReal: `${trustedRoot}/gh`,
    ghWrapper: `${root}/gh`,
    vercelWrapper: `${root}/vercel`,
    signedCommit: `${root}/gh-signed-commit`,
    trustedSignedCommit: `${trustedRoot}/gh-signed-commit`,
    typescriptRoot: `${root}/typescript`,
    typescriptModule: `${root}/typescript/node_modules/typescript`,
    worker: `${root}/diagnostics.cjs`,
  };
}

export function ghWrapperSource(sandbox: Pick<SandboxSession, "resolvePath">): string {
  const paths = toolingPaths(sandbox);
  return `#!/usr/bin/env bash\nset -euo pipefail\n[[ ! -f ${JSON.stringify(paths.env)} ]] || source ${JSON.stringify(paths.env)}\nexport GH_TOKEN="\${GH_TOKEN:-ghp_000000000000000000000000000000000000}"\nexec ${JSON.stringify(paths.ghReal)} "$@"\n`;
}

export function vercelWrapperSource(sandbox: Pick<SandboxSession, "resolvePath">): string {
  const paths = toolingPaths(sandbox);
  return `#!/usr/bin/env bash\nset -euo pipefail\n[[ ! -f ${JSON.stringify(paths.env)} ]] || source ${JSON.stringify(paths.env)}\nexport VERCEL_TOKEN="\${VERCEL_TOKEN:-eve-code-firewall-placeholder}"\nexec node "$(npm root -g)/vercel/dist/index.js" "$@"\n`;
}

export function typescriptInstallCommand(sandbox: Pick<SandboxSession, "resolvePath">): string {
  return (
    `npm install --prefix ${toolingPaths(sandbox).typescriptRoot} --ignore-scripts --no-audit --no-fund ` +
    `typescript@${TYPESCRIPT_VERSION}`
  );
}

/**
 * Runs inside the sandbox with `node`. Reads one base64 JSON request from
 * `EVE_CODE_DIAGNOSTICS_REQUEST` (`{ repoRoot, filePath, typescriptPath }`),
 * prefers the repository's own TypeScript, and prints `{ diagnostics }`.
 */
export const DIAGNOSTICS_WORKER_SOURCE = String.raw`const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const { EVE_CODE_DIAGNOSTICS_REQUEST = "" } = require("node:process").env;
const request = JSON.parse(Buffer.from(EVE_CODE_DIAGNOSTICS_REQUEST, "base64").toString());
const repoRoot = fs.realpathSync(request.repoRoot);
const fileName = fs.realpathSync(path.join(repoRoot, request.filePath));
if (fileName !== repoRoot && !fileName.startsWith(repoRoot + path.sep)) {
  throw new Error("file escapes repository: " + request.filePath);
}

const ts = loadTypeScript();
const projectPath = nearestConfig(path.dirname(fileName));
let fileNames;
let options;
if (projectPath) {
  const read = ts.readConfigFile(projectPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(projectPath));
  fileNames = parsed.fileNames;
  options = parsed.options;
} else {
  fileNames = [fileName];
  options = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  };
}
if (!fileNames.some((candidate) => sameFile(candidate, fileName))) fileNames.push(fileName);

const host = {
  directoryExists: ts.sys.directoryExists,
  fileExists: ts.sys.fileExists,
  getCompilationSettings: () => options,
  getCurrentDirectory: () => repoRoot,
  getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
  getNewLine: () => ts.sys.newLine,
  getScriptFileNames: () => fileNames,
  getScriptSnapshot(candidate) {
    const content = ts.sys.readFile(candidate);
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
  },
  getScriptVersion: () => "0",
  readDirectory: ts.sys.readDirectory,
  readFile: ts.sys.readFile,
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const source = service.getProgram()?.getSourceFile(fileName);
if (!source) throw new Error("TypeScript could not load " + request.filePath);

const diagnostics = [
  ...service.getSyntacticDiagnostics(fileName),
  ...service.getSemanticDiagnostics(fileName),
]
  .slice(0, 50)
  .map((diagnostic) => {
    const start = source.getLineAndCharacterOfPosition(diagnostic.start || 0);
    return {
      code: diagnostic.code,
      column: start.character + 1,
      line: start.line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").slice(0, 1000),
    };
  });
process.stdout.write(JSON.stringify({ diagnostics }));

function loadTypeScript() {
  try {
    return createRequire(path.join(repoRoot, "package.json"))("typescript");
  } catch {
    return require(request.typescriptPath);
  }
}

function nearestConfig(start) {
  let current = start;
  while (current === repoRoot || current.startsWith(repoRoot + path.sep)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (current === repoRoot) break;
    current = path.dirname(current);
  }
  return null;
}

function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
`;
