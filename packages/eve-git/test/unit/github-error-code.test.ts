import assert from "node:assert/strict";
import test from "node:test";

import { githubErrorCode } from "../../extension/lib/github-error-code.ts";

const failed = (stderr: string, exitCode = 1) => githubErrorCode({ exitCode, stderr });

const PUSH_TO = "To https://github.com/acme/widgets\n";
const FAILED_PUSH = "error: failed to push some refs to 'https://github.com/acme/widgets'\n";

test("names git push rejections", () => {
  const samples: [string, string][] = [
    [
      `${PUSH_TO} ! [rejected]        main -> main (non-fast-forward)\n${FAILED_PUSH}hint: Updates were rejected because the tip of your current branch is behind\n`,
      "non-fast-forward",
    ],
    [
      `${PUSH_TO} ! [rejected]        feat -> feat (fetch first)\n${FAILED_PUSH}hint: Updates were rejected because the remote contains work that you do not\n`,
      "non-fast-forward",
    ],
    [
      `${PUSH_TO} ! [rejected]        feat -> feat (stale info)\n${FAILED_PUSH}`,
      "non-fast-forward",
    ],
    [
      `${PUSH_TO} ! [rejected]        v1.0 -> v1.0 (already exists)\n${FAILED_PUSH}`,
      "non-fast-forward",
    ],
    [
      `remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.\n${PUSH_TO} ! [remote rejected] main -> main (protected branch hook declined)\n${FAILED_PUSH}`,
      "protected-branch",
    ],
    [
      `remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Cannot update this protected ref.\n${PUSH_TO} ! [remote rejected] main -> main (push declined due to repository rule violations)\n${FAILED_PUSH}`,
      "rule-violation",
    ],
    [
      `remote: error: GH013: Repository rule violations found for refs/heads/feat.\nremote: - GITHUB PUSH PROTECTION\nremote:   Push cannot contain secrets\n${PUSH_TO} ! [remote rejected] feat -> feat (push declined due to repository rule violations)\n${FAILED_PUSH}`,
      "push-protection",
    ],
    [
      `remote: error: GH009: Secrets detected! This push failed.\n${PUSH_TO} ! [remote rejected] feat -> feat (pre-receive hook declined)\n${FAILED_PUSH}`,
      "push-protection",
    ],
    [
      `remote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected.\n${PUSH_TO} ! [remote rejected] feat -> feat (pre-receive hook declined)\n${FAILED_PUSH}`,
      "too-large",
    ],
    [
      `${PUSH_TO} ! [remote rejected] feat -> feat (pre-receive hook declined)\n${FAILED_PUSH}`,
      "hook-declined",
    ],
    [
      "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission\n",
      "permission-denied",
    ],
  ];
  for (const [stderr, code] of samples) assert.equal(failed(stderr), code, stderr);
});

test("names authentication, access, and availability failures from git and gh", () => {
  const samples: [string, string, number?][] = [
    [
      "remote: Permission to acme/widgets.git denied to eve-bot[bot].\nfatal: unable to access 'https://github.com/acme/widgets/': The requested URL returned error: 403\n",
      "permission-denied",
      128,
    ],
    [
      "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/acme/widgets/pulls)\n",
      "permission-denied",
    ],
    [
      "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/widgets/'\n",
      "unauthenticated",
      128,
    ],
    ["HTTP 401: Bad credentials (https://api.github.com/graphql)\n", "unauthenticated"],
    [
      "remote: Repository not found.\nfatal: repository 'https://github.com/acme/widgets/' not found\n",
      "not-found",
      128,
    ],
    [
      "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)\n",
      "not-found",
    ],
    ["gh: Not Found (HTTP 404)\n", "not-found"],
    [
      "HTTP 403: API rate limit exceeded for installation ID 1. (https://api.github.com/repos/acme/widgets)\n",
      "rate-limited",
    ],
    [
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\n",
      "rate-limited",
    ],
    ["HTTP 502: Bad Gateway (https://api.github.com/graphql)\n", "server-error"],
    ["error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500\n", "server-error"],
    [
      "fatal: unable to access 'https://github.com/acme/widgets/': Could not resolve host: github.com\n",
      "network",
      128,
    ],
    [
      "error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly\nfatal: early EOF\n",
      "network",
      128,
    ],
    ['Post "https://api.github.com/graphql": dial tcp: i/o timeout\n', "network"],
  ];
  for (const [stderr, code, exitCode] of samples)
    assert.equal(failed(stderr, exitCode), code, stderr);
});

test("falls back to command-failed for unrecognized failures, including unrelated already-exists errors", () => {
  assert.equal(
    failed(
      "fatal: destination path 'widgets' already exists and is not an empty directory.\n",
      128,
    ),
    "command-failed",
  );
  assert.equal(failed("fatal: a branch named 'feat' already exists\n", 128), "command-failed");
  assert.equal(
    failed(
      'a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/acme/widgets/pull/7\n',
    ),
    "command-failed",
  );
  assert.equal(failed('unknown command "frob" for "gh"\n'), "command-failed");
});

test("reports nothing for successes, even with progress on stderr", () => {
  assert.equal(
    githubErrorCode({
      exitCode: 0,
      stderr: `remote: Resolving deltas: 100% (3/3)\n${PUSH_TO}   1a2b3c4..5d6e7f8  main -> main\n`,
    }),
    undefined,
  );
  assert.equal(
    githubErrorCode({
      exitCode: 0,
      stderr:
        "remote: Bypassed rule violations for refs/heads/main:\nremote: - GH013 rules bypassed\n",
    }),
    undefined,
  );
});

test("treats a nonzero exit that answers a question as no failure", () => {
  for (const exitCode of [1, 8]) assert.equal(failed("", exitCode), undefined);
  assert.equal(failed("\n  \n"), undefined);
  assert.equal(failed('no pull requests found for branch "feat"\n'), undefined);
  assert.equal(failed("no checks reported on the 'feat' branch\n"), undefined);
});

test("names a command killed by a signal", () => {
  assert.equal(failed("", 137), "terminated");
  assert.equal(failed("remote: Counting objects: 42%\n", 143), "terminated");
});

test("classifies the tail eve keeps of truncated stderr", () => {
  const head = "[output truncated: showing final 100000 bytes]\n";
  assert.equal(
    failed(
      `${head}remote: Resolving deltas\n ! [rejected]        main -> main (fetch first)\n${FAILED_PUSH}`,
    ),
    "non-fast-forward",
  );
  assert.equal(failed(`${head}${FAILED_PUSH}`), "command-failed");
});
