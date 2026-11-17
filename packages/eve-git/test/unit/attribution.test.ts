import assert from "node:assert/strict";
import test from "node:test";

import {
  attributeCommand,
  coAuthorTrailer,
  commentFooter,
  isAttributable,
  withFooter,
  withTrailer,
} from "../../extension/lib/attribution.ts";

const TRAILER = "Co-authored-by: octocat <1+octocat@users.noreply.github.com>";
const FOOTER = "<sub>Sent using V</sub>";

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async read(path: string) {
      return store.get(path) ?? null;
    },
    async write(content: string) {
      const path = `/tmp/body-${store.size}.md`;
      store.set(path, content);
      return path;
    },
  };
}

function attribute(argv: string[], sandbox = files(), footer: string | null = FOOTER) {
  return attributeCommand(argv, { footer, trailer: TRAILER }, sandbox, "/workspace/repo");
}

function refusal(argv: string[], sandbox = files()) {
  return attribute(argv, sandbox).then((result) => {
    assert.ok(!Array.isArray(result), `expected ${JSON.stringify(argv)} to be refused`);
    return result.refused;
  });
}

test("formats a trailer and rejects values that could inject lines", () => {
  assert.equal(
    coAuthorTrailer({ name: "octocat", email: "1+octocat@users.noreply.github.com" }),
    TRAILER,
  );
  assert.throws(() => coAuthorTrailer({ name: "a\nCo-authored-by: b", email: "a@b.c" }), /name/u);
  assert.throws(() => coAuthorTrailer({ name: "a", email: "a@b.c>\nx" }), /email/u);
});

test("reads the comment footer from the co-author and rejects multi-line footers", () => {
  assert.equal(commentFooter({ name: "v", email: "v@x.y" }), null);
  assert.equal(commentFooter({ name: "v", email: "v@x.y", commentFooter: ` ${FOOTER} ` }), FOOTER);
  assert.throws(
    () => commentFooter({ name: "v", email: "v@x.y", commentFooter: "a\nb" }),
    /footer/u,
  );
  assert.throws(() => commentFooter({ name: "v", email: "v@x.y", commentFooter: " " }), /footer/u);
});

test("appends the trailer once", () => {
  assert.equal(withTrailer("", TRAILER), TRAILER);
  assert.equal(withTrailer("Fix it.\n", TRAILER), `Fix it.\n\n${TRAILER}`);
  assert.equal(withTrailer(`Fix it.\n\n${TRAILER}`, TRAILER), `Fix it.\n\n${TRAILER}`);
});

test("extends an existing trailer block so earlier co-authors still count", () => {
  const existing = "Fix it.\n\nCo-authored-by: A <a@x.y>\n";
  assert.equal(withTrailer(existing, TRAILER), `Fix it.\n\nCo-authored-by: A <a@x.y>\n${TRAILER}`);
  assert.equal(withTrailer("Note: details", TRAILER), `Note: details\n\n${TRAILER}`);
  assert.equal(
    withTrailer("Fix it.\n\nSee: this is prose\nacross lines", TRAILER),
    `Fix it.\n\nSee: this is prose\nacross lines\n\n${TRAILER}`,
  );
});

test("skips the footer only when the body already ends with it", () => {
  assert.equal(withFooter("", FOOTER), FOOTER);
  assert.equal(withFooter("Done.\n", FOOTER), `Done.\n\n${FOOTER}`);
  assert.equal(withFooter(`Done.\n\n${FOOTER}\n`, FOOTER), `Done.\n\n${FOOTER}\n`);
  const quoted = `> Fixed.\n>\n> ${FOOTER}\n\nThanks.`;
  assert.equal(withFooter(quoted, FOOTER), `${quoted}\n\n${FOOTER}`);
});

test("adds the trailer to signed commit bodies", async () => {
  assert.deepEqual(await attribute(["gh-signed-commit", "--repo", "o/r", "-m", "Fix"]), [
    "gh-signed-commit",
    "--repo",
    "o/r",
    "-m",
    "Fix",
    "-b",
    TRAILER,
  ]);
  assert.deepEqual(await attribute(["gh-signed-commit", "-m", "Fix", "-b", "A", "-b", "Why."]), [
    "gh-signed-commit",
    "-m",
    "Fix",
    "-b",
    "A",
    "-b",
    `Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh-signed-commit", "-m", "-b", "--branch", "main"]), [
    "gh-signed-commit",
    "-m",
    "-b",
    "--branch",
    "main",
    "-b",
    TRAILER,
  ]);
});

test("adds the trailer to pull request bodies without touching the model's file", async () => {
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body=Why."]), [
    "gh",
    "pr",
    "create",
    `--body=Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "-bWhy."]), [
    "gh",
    "pr",
    "create",
    `-b=Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "-b=Why."]), [
    "gh",
    "pr",
    "create",
    `-b=Why.\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "-db", "Why."]), [
    "gh",
    "pr",
    "create",
    "-db",
    `Why.\n\n${TRAILER}`,
  ]);
  const sandbox = files({ "/workspace/repo/pr.md": "Why.\n" });
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body-file", "pr.md"], sandbox), [
    "gh",
    "pr",
    "create",
    "--body-file",
    "/tmp/body-1.md",
  ]);
  assert.equal(sandbox.store.get("/tmp/body-1.md"), `Why.\n\n${TRAILER}`);
  assert.equal(sandbox.store.get("/workspace/repo/pr.md"), "Why.\n");
  assert.deepEqual(await attribute(["gh", "pr", "create", "-Fpr.md"], sandbox), [
    "gh",
    "pr",
    "create",
    "-F=/tmp/body-2.md",
  ]);
});

test("reads a body that starts with a dash as the body, not as flags", async () => {
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body", "-Fixed the typo"]), [
    "gh",
    "pr",
    "create",
    "--body",
    `-Fixed the typo\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body", "-bump to v2"]), [
    "gh",
    "pr",
    "create",
    "--body",
    `-bump to v2\n\n${TRAILER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "comment", "1", "--body", "-Fixed the typo"]), [
    "gh",
    "pr",
    "comment",
    "1",
    "--body",
    `-Fixed the typo\n\n${FOOTER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "comment", "1", "--body", "-bump to v2"]), [
    "gh",
    "pr",
    "comment",
    "1",
    "--body",
    `-bump to v2\n\n${FOOTER}`,
  ]);
  assert.deepEqual(await attribute(["gh", "pr", "create", "--title", "-b", "--body", "Why."]), [
    "gh",
    "pr",
    "create",
    "--title",
    "-b",
    "--body",
    `Why.\n\n${TRAILER}`,
  ]);
});

test("adds the footer to pr and issue comments and reviews", async () => {
  for (const [argv, expected] of [
    [
      ["gh", "pr", "comment", "12", "--body", "Fixed."],
      ["gh", "pr", "comment", "12", "--body", `Fixed.\n\n${FOOTER}`],
    ],
    [
      ["gh", "issue", "comment", "12", "-b", "Fixed."],
      ["gh", "issue", "comment", "12", "-b", `Fixed.\n\n${FOOTER}`],
    ],
    [
      ["gh", "pr", "review", "12", "--comment", "-bLooks good."],
      ["gh", "pr", "review", "12", "--comment", `-b=Looks good.\n\n${FOOTER}`],
    ],
    [
      ["gh", "pr", "review", "12", "-rb", "Needs tests."],
      ["gh", "pr", "review", "12", "-rb", `Needs tests.\n\n${FOOTER}`],
    ],
    [
      ["gh", "--repo", "o/r", "pr", "comment", "12", "--body", "Fixed."],
      ["gh", "--repo", "o/r", "pr", "comment", "12", "--body", `Fixed.\n\n${FOOTER}`],
    ],
    [
      ["gh", "pr", "-R", "o/r", "comment", "12", "--body=Fixed."],
      ["gh", "pr", "-R", "o/r", "comment", "12", `--body=Fixed.\n\n${FOOTER}`],
    ],
    [
      ["gh", "pr", "comment", "12", "--edit-last", "--body", `Fixed.\n\n${FOOTER}`],
      ["gh", "pr", "comment", "12", "--edit-last", "--body", `Fixed.\n\n${FOOTER}`],
    ],
  ] as const) {
    assert.deepEqual(await attribute([...argv]), expected);
  }
  const sandbox = files({ "/workspace/repo/c.md": "Fixed.\n" });
  assert.deepEqual(await attribute(["gh", "pr", "comment", "12", "-F", "c.md"], sandbox), [
    "gh",
    "pr",
    "comment",
    "12",
    "-F",
    "/tmp/body-1.md",
  ]);
  assert.equal(sandbox.store.get("/tmp/body-1.md"), `Fixed.\n\n${FOOTER}`);
  assert.equal(sandbox.store.get("/workspace/repo/c.md"), "Fixed.\n");
});

test("adds the footer to REST comment, review, and reply bodies", async () => {
  for (const endpoint of [
    "repos/o/r/issues/12/comments",
    "repos/o/r/pulls/12/comments",
    "repos/o/r/commits/abc123/comments",
    "repos/o/r/pulls/12/reviews",
    "repos/o/r/pulls/12/reviews/9",
    "repos/o/r/pulls/12/comments/99/replies",
    "repos/{owner}/{repo}/pulls/comments/99",
    "/repos/o/r/issues/comments/99",
    "https://api.github.com/repos/o/r/issues/12/comments",
  ]) {
    assert.deepEqual(await attribute(["gh", "api", endpoint, "-f", "body=Fixed."]), [
      "gh",
      "api",
      endpoint,
      "-f",
      `body=Fixed.\n\n${FOOTER}`,
    ]);
  }
  assert.deepEqual(
    await attribute([
      "gh",
      "api",
      "-X",
      "POST",
      "repos/o/r/pulls/12/reviews",
      "-f",
      "event=COMMENT",
      "--raw-field=body=Summary.",
      "-f",
      "comments[][path]=a.ts",
      "-F",
      "comments[][line]=3",
      "-f",
      "comments[][body]=Nit.",
    ]),
    [
      "gh",
      "api",
      "-X",
      "POST",
      "repos/o/r/pulls/12/reviews",
      "-f",
      "event=COMMENT",
      `--raw-field=body=Summary.\n\n${FOOTER}`,
      "-f",
      "comments[][path]=a.ts",
      "-F",
      "comments[][line]=3",
      "-f",
      `comments[][body]=Nit.\n\n${FOOTER}`,
    ],
  );
  assert.deepEqual(
    await attribute(["gh", "api", "repos/o/r/issues/12/comments", "-f", "body=-Fixed it"]),
    ["gh", "api", "repos/o/r/issues/12/comments", "-f", `body=-Fixed it\n\n${FOOTER}`],
  );
  assert.deepEqual(
    await attribute(["gh", "api", "repos/o/r/issues/12/comments", "-f", "body=@x"]),
    ["gh", "api", "repos/o/r/issues/12/comments", "-f", `body=@x\n\n${FOOTER}`],
  );
});

test("adds the footer to REST body files and --input JSON without touching the model's files", async () => {
  const review = { event: "COMMENT", body: "Summary.", comments: [{ path: "a.ts", body: "Nit." }] };
  const sandbox = files({
    "/workspace/repo/c.md": "Fixed.",
    "/workspace/repo/review.json": JSON.stringify(review),
  });
  assert.deepEqual(
    await attribute(["gh", "api", "repos/o/r/issues/12/comments", "-F", "body=@c.md"], sandbox),
    ["gh", "api", "repos/o/r/issues/12/comments", "-F", "body=@/tmp/body-2.md"],
  );
  assert.equal(sandbox.store.get("/tmp/body-2.md"), `Fixed.\n\n${FOOTER}`);
  assert.deepEqual(
    await attribute(["gh", "api", "repos/o/r/pulls/12/reviews", "--input", "review.json"], sandbox),
    ["gh", "api", "repos/o/r/pulls/12/reviews", "--input", "/tmp/body-3.md"],
  );
  assert.deepEqual(JSON.parse(sandbox.store.get("/tmp/body-3.md")!), {
    ...review,
    body: `Summary.\n\n${FOOTER}`,
    comments: [{ path: "a.ts", body: `Nit.\n\n${FOOTER}` }],
  });
  assert.equal(sandbox.store.get("/workspace/repo/review.json"), JSON.stringify(review));
});

test("refuses comments the footer cannot be added to", async () => {
  assert.match(await refusal(["gh", "pr", "comment", "1", "--body-file", "-"]), /--body/u);
  assert.match(
    await refusal(["gh", "pr", "review", "1", "-F", "missing.md"]),
    /"missing\.md" not found/u,
  );
  assert.match(
    await refusal(["gh", "api", "repos/o/r/issues/1/comments", "-F", "body=@-"]),
    /-f body=/u,
  );
  assert.match(
    await refusal(["gh", "api", "repos/o/r/issues/1/comments", "--input", "-"]),
    /-f body=/u,
  );
  assert.match(
    await refusal(["gh", "api", "repos/o/r/issues/1/comments", "-F", "body=@missing.md"]),
    /"missing\.md" not found/u,
  );
  assert.match(
    await refusal(["gh", "api", "repos/o/r/issues/1/comments", "--input", "missing.json"]),
    /"missing\.json" not found/u,
  );
  assert.match(
    await refusal(
      ["gh", "api", "repos/o/r/issues/1/comments", "--input", "bad.json"],
      files({ "/workspace/repo/bad.json": "[1]" }),
    ),
    /not a JSON object/u,
  );
  assert.match(
    await refusal([
      "gh",
      "api",
      "-X",
      "POST",
      "repos/o/r/pulls/1/reviews/9/events",
      "-f",
      "event=COMMENT",
    ]),
    /pulls\/<number>\/reviews -f event=COMMENT -f body=/u,
  );
  const reply =
    'mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: "T", body: "Fixed."}) { comment { id } } }';
  assert.match(
    await refusal(["gh", "api", "graphql", "-f", `query=${reply}`]),
    /comments\/<comment_id>\/replies -f body=/u,
  );
  assert.match(
    await refusal(
      ["gh", "api", "graphql", "-F", "query=@q.graphql"],
      files({ "/workspace/repo/q.graphql": reply }),
    ),
    /REST/u,
  );
  assert.match(
    await refusal(
      ["gh", "api", "graphql", "--input", "q.json"],
      files({ "/workspace/repo/q.json": JSON.stringify({ query: reply }) }),
    ),
    /REST/u,
  );
  assert.match(await refusal(["gh", "api", "graphql", "-F", "query=@-"]), /-f query=/u);
});

test("passes GraphQL reads and mutations that post no comment", async () => {
  for (const argv of [
    ["gh", "api", "graphql", "-f", "query={ viewer { login } }"],
    [
      "gh",
      "api",
      "graphql",
      "-f",
      'query=mutation { resolveReviewThread(input: {threadId: "T"}) { thread { id } } }',
    ],
  ]) {
    assert.deepEqual(await attribute(argv), argv);
  }
});

test("leaves comments unchanged and refuses nothing when no footer is configured", async () => {
  for (const argv of [
    ["gh", "pr", "comment", "1", "--body", "hi"],
    ["gh", "pr", "comment", "1", "--body-file", "-"],
    ["gh", "api", "repos/o/r/issues/1/comments", "-f", "body=hi"],
    ["gh", "api", "repos/o/r/pulls/1/reviews/9/events", "-f", "event=COMMENT"],
    ["gh", "api", "graphql", "-f", "query=mutation { addComment(input: {}) { clientMutationId } }"],
  ]) {
    assert.deepEqual(await attribute(argv, files(), null), argv);
  }
});

test("leaves other commands unchanged", async () => {
  for (const argv of [
    ["gh", "pr", "create", "--fill"],
    ["gh", "pr", "create", "--template", "bug.md"],
    ["gh", "pr", "create", "--body-file", "-"],
    ["gh", "pr", "review", "1", "--approve"],
    ["gh", "api", "repos/o/r/issues/1/comments"],
    ["gh", "api", "repos/o/r/issues/1/comments", "-f", "per_page=100"],
    ["git", "push", "origin", "HEAD"],
  ]) {
    assert.deepEqual(await attribute(argv), argv);
  }
});

test("resolves attribution only for commands that can publish", () => {
  for (const argv of [
    ["gh-signed-commit", "-m", "Fix"],
    ["gh", "pr", "create"],
    ["gh", "pr", "comment", "1"],
    ["gh", "-R", "o/r", "issue", "comment", "1"],
    ["gh", "pr", "review", "1"],
    ["gh", "api", "-X", "POST", "repos/o/r/issues/1/comments"],
    ["gh", "api", "repos/o/r/pulls/1/reviews/9/events"],
    ["gh", "api", "graphql"],
  ]) {
    assert.equal(isAttributable(argv), true, argv.join(" "));
  }
  for (const argv of [
    ["gh", "pr", "view", "1"],
    ["gh", "issue", "list"],
    ["gh", "api", "repos/o/r/pulls/1"],
    ["git", "push"],
  ]) {
    assert.equal(isAttributable(argv), false, argv.join(" "));
  }
});

test("reports a missing pull request body file", async () => {
  assert.deepEqual(await attribute(["gh", "pr", "create", "--body-file", "missing.md"]), {
    refused: 'Pull request body file "missing.md" not found.',
  });
});
