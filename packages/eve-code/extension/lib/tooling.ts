import type { SandboxSession } from "eve/sandbox";

import {
  GH_SIGNED_COMMIT_SOURCE,
  GH_SIGNED_COMMIT_VERSION,
  GITHUB_TOOLING_PATHS,
} from "eve/internal/git";
import { shellQuote } from "./shell.ts";

export { GH_SIGNED_COMMIT_SOURCE, GH_SIGNED_COMMIT_VERSION };
export const TYPESCRIPT_VERSION = "6.0.3";
export const GH_VERSION = "2.103.3";
/** SHA-256 of `gh_${GH_VERSION}_linux_<arch>.tar.gz` from the release's `gh_${GH_VERSION}_checksums.txt`. */
const GH_TARBALL_SHA256 = {
  amd64: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
  arm64: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
} as const;
const TOOLING_DIR = ".eve-code";
const TRUSTED_TOOLING_ROOT = "/usr/local/lib/eve-code";
const TYPESCRIPT_MODULE = `${TRUSTED_TOOLING_ROOT}/typescript/node_modules/typescript/lib/typescript.js`;

export function toolingPaths(sandbox: Pick<SandboxSession, "resolvePath">) {
  const root = sandbox.resolvePath(TOOLING_DIR);
  const trustedRoot = TRUSTED_TOOLING_ROOT;
  return {
    root,
    trustedRoot,
    env: `${root}/env`,
    ghReal: GITHUB_TOOLING_PATHS.ghReal,
    ghWrapper: `${root}/gh`,
    vercelWrapper: `${root}/vercel`,
    signedCommit: `${root}/gh-signed-commit`,
    trustedSignedCommit: GITHUB_TOOLING_PATHS.trustedSignedCommit,
    typescriptRoot: `${trustedRoot}/typescript`,
    typescriptModule: TYPESCRIPT_MODULE,
    workerSource: `${root}/diagnostics.cjs`,
    worker: `${trustedRoot}/diagnostics.cjs`,
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

/** Installs GitHub's release build of `gh` at `ghReal`. Expects `$INSTALL` from the caller's script. */
export function ghInstallCommand(): string {
  const release = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
  return [
    'case "$(uname -m)" in',
    `  x86_64) GH_ARCH=amd64 GH_SHA256=${GH_TARBALL_SHA256.amd64} ;;`,
    `  aarch64 | arm64) GH_ARCH=arm64 GH_SHA256=${GH_TARBALL_SHA256.arm64} ;;`,
    `  *) echo "eve-code has no gh build for $(uname -m)" >&2; exit 1 ;;`,
    "esac",
    'GH_TMP="$(mktemp -d)"',
    `curl -fsSL -o "$GH_TMP/gh.tar.gz" "${release}/gh_${GH_VERSION}_linux_$GH_ARCH.tar.gz"`,
    'echo "$GH_SHA256  $GH_TMP/gh.tar.gz" | sha256sum -c -',
    `tar -xzf "$GH_TMP/gh.tar.gz" -C "$GH_TMP" --strip-components=2 "gh_${GH_VERSION}_linux_$GH_ARCH/bin/gh"`,
    `$INSTALL -m 755 "$GH_TMP/gh" ${shellQuote(GITHUB_TOOLING_PATHS.ghReal)}`,
    'rm -rf "$GH_TMP"',
  ].join("\n");
}

export function typescriptInstallCommand(sandbox: Pick<SandboxSession, "resolvePath">): string {
  const { typescriptRoot } = toolingPaths(sandbox);
  const globalConfig = `${typescriptRoot}/npmrc`;
  // Neither npm configuration nor executables may come from the writable workspace or home.
  const install = [
    "set -e",
    `cd ${shellQuote(typescriptRoot)}`,
    "umask 022",
    `: > ${shellQuote(globalConfig)}`,
    `npm install --prefix ${shellQuote(typescriptRoot)} --ignore-scripts --no-audit --no-fund typescript@${TYPESCRIPT_VERSION}`,
    `chmod -R go-w ${shellQuote(typescriptRoot)}`,
  ].join("\n");
  const command =
    "/usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin " +
    `NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=${shellQuote(globalConfig)} ` +
    "NPM_CONFIG_REGISTRY=https://registry.npmjs.org " +
    `/bin/sh -c ${shellQuote(install)}`;
  return `if [ "$(id -u)" = 0 ]; then ${command}; else sudo -n ${command}; fi`;
}

/**
 * Runs inside the sandbox with `node`. Reads one base64 JSON request from
 * `EVE_CODE_DIAGNOSTICS_REQUEST` (`{ patchRoot, filePath }`), loads only the
 * bootstrap-installed compiler, and prints `{ diagnostics }`.
 */
export const DIAGNOSTICS_WORKER_SOURCE = String.raw`const fs = require("node:fs");
const path = require("node:path");

const { EVE_CODE_DIAGNOSTICS_REQUEST = "" } = require("node:process").env;
const request = JSON.parse(Buffer.from(EVE_CODE_DIAGNOSTICS_REQUEST, "base64").toString());
const patchRoot = fs.realpathSync(request.patchRoot);
const fileName = fs.realpathSync(path.join(patchRoot, request.filePath));
if (fileName !== patchRoot && !fileName.startsWith(patchRoot + path.sep)) {
  throw new Error("file escapes repository: " + request.filePath);
}

const ts = require(${JSON.stringify(TYPESCRIPT_MODULE)});
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
  getCurrentDirectory: () => patchRoot,
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

function nearestConfig(start) {
  let current = start;
  while (current === patchRoot || current.startsWith(patchRoot + path.sep)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (current === patchRoot) break;
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
