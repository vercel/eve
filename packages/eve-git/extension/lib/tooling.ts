const TRUSTED_TOOLING_ROOT = "/usr/local/lib/eve-code";

export const GITHUB_TOOLING_PATHS = {
  ghReal: `${TRUSTED_TOOLING_ROOT}/gh`,
  trustedSignedCommit: `${TRUSTED_TOOLING_ROOT}/gh-signed-commit`,
} as const;
