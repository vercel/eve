import type { SandboxSession } from "eve/sandbox";

import {
  GH_SIGNED_COMMIT_SOURCE,
  GH_SIGNED_COMMIT_VERSION,
  GITHUB_TOOLING_PATHS,
} from "eve/internal/git";

export { GH_SIGNED_COMMIT_SOURCE, GH_SIGNED_COMMIT_VERSION };
const TOOLING_DIR = ".eve-code";
const TRUSTED_TOOLING_ROOT = "/usr/local/lib/eve-code";

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
