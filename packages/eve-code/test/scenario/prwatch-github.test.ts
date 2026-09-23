import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  advancePullRequestWatchNotification,
  framePullRequestWatchWake,
  initialPullRequestWatchNotificationState,
  isRetryablePullRequestWatchError,
  PullRequestWatchInputSchema,
  pullRequestWatchSnapshot,
  shouldRefreshPullRequestWatchToken,
} from "../../extension/lib/prwatch-github.ts";

const HEAD = "b".repeat(40);
const OLD_HEAD = "a".repeat(40);

function pullRequest() {
  return {
    head: { sha: HEAD },
    html_url: "https://github.com/vercel/eve/pull/42",
    merged: false,
    state: "open" as const,
  };
}

function review(input: { commit: string; state: string; submittedAt: string }) {
  return {
    commit_id: input.commit,
    state: input.state,
    submitted_at: input.submittedAt,
    user: { login: "ruiconti" },
  };
}

test("frames watcher wakes as internal work rather than progress reports", () => {
  const instruction = "Inspect the PR and continue the original issue.";
  const framed = framePullRequestWatchWake(instruction);

  assert.equal(framed.startsWith(`${instruction}\n\n`), true);
  assert.match(framed, /internal watch wake/u);
  assert.match(framed, /original request is complete/u);
  assert.match(framed, /new blocker requires human input/u);
  assert.match(framed, /exactly <eve-empty-delivery\/>/u);
  assert.match(framed, /Do not report that nothing changed/u);
});

test("accepts only the owner's latest review on the live PR head", () => {
  const approved = pullRequestWatchSnapshot({
    pullRequest: pullRequest(),
    reviewOwner: "RuiConti",
    reviews: [
      review({ commit: OLD_HEAD, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z" }),
      review({ commit: HEAD, state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T00:00:00Z" }),
      review({ commit: HEAD, state: "APPROVED", submittedAt: "2026-01-03T00:00:00Z" }),
    ],
  });
  assert.equal(approved.ownerApprovedCurrentHead, true);
  assert.equal(approved.ownerReviewState, "APPROVED");
  assert.equal(approved.ownerReviewSubmittedAt, "2026-01-03T00:00:00Z");

  const revoked = pullRequestWatchSnapshot({
    pullRequest: pullRequest(),
    reviewOwner: "ruiconti",
    reviews: [
      review({ commit: HEAD, state: "APPROVED", submittedAt: "2026-01-03T00:00:00Z" }),
      review({ commit: HEAD, state: "CHANGES_REQUESTED", submittedAt: "2026-01-04T00:00:00Z" }),
    ],
  });
  assert.equal(revoked.ownerApprovedCurrentHead, false);
  assert.equal(revoked.ownerReviewState, "CHANGES_REQUESTED");
});

test("never treats approval of the red or an older head as current", () => {
  const snapshot = pullRequestWatchSnapshot({
    pullRequest: pullRequest(),
    reviewOwner: "ruiconti",
    reviews: [review({ commit: OLD_HEAD, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z" })],
  });
  assert.equal(snapshot.ownerApprovedCurrentHead, false);
});

test("wakes once for a red-head stall and only for material later changes", () => {
  const redHead = OLD_HEAD;
  let state = initialPullRequestWatchNotificationState();
  const snapshot = (input: { head: string; reviewState?: string }) => ({
    headOid: input.head,
    ownerApprovedCurrentHead: input.reviewState === "APPROVED",
    ownerReviewState: input.reviewState ?? null,
    ownerReviewSubmittedAt: input.reviewState ? "2026-01-01T00:00:00Z" : null,
    state: "open" as const,
    url: "https://github.com/vercel/eve/pull/42",
  });
  const advance = (current: ReturnType<typeof snapshot>) => {
    const result = advancePullRequestWatchNotification({
      redHeadOid: redHead,
      snapshot: current,
      staleAfterPolls: 4,
      state,
    });
    state = result.state;
    return result.wakeReason;
  };

  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), "red_head_stalled");
  assert.equal(advance(snapshot({ head: redHead })), null);

  assert.equal(advance(snapshot({ head: HEAD })), "head_changed");
  assert.equal(advance(snapshot({ head: HEAD })), null);
  assert.equal(
    advance(snapshot({ head: HEAD, reviewState: "CHANGES_REQUESTED" })),
    "owner_review_changed",
  );
  assert.equal(advance(snapshot({ head: HEAD, reviewState: "CHANGES_REQUESTED" })), null);

  assert.equal(advance(snapshot({ head: redHead })), "head_changed");
  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), null);
  assert.equal(advance(snapshot({ head: redHead })), null);
});

test("uses the red head as the initial notification baseline", () => {
  const snapshot = (
    head: string,
    reviews: Parameters<typeof pullRequestWatchSnapshot>[0]["reviews"],
  ) =>
    pullRequestWatchSnapshot({
      pullRequest: { ...pullRequest(), head: { sha: head } },
      reviewOwner: "ruiconti",
      reviews,
    });
  const advance = (current: ReturnType<typeof snapshot>) =>
    advancePullRequestWatchNotification({
      redHeadOid: OLD_HEAD,
      snapshot: current,
      staleAfterPolls: 4,
      state: initialPullRequestWatchNotificationState(),
    }).wakeReason;

  assert.equal(advance(snapshot(OLD_HEAD, [])), null);
  assert.equal(
    advance(
      snapshot(HEAD, [
        review({
          commit: HEAD,
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-01-01T00:00:00Z",
        }),
      ]),
    ),
    "head_changed",
  );
});

test("normalizes watched SHAs and retries only temporary read failures", () => {
  const input = PullRequestWatchInputSchema.parse({
    pullRequestNumber: 42,
    redHeadOid: "A".repeat(40),
    repo: "vercel/eve",
    reviewOwner: "ruiconti",
  });
  assert.equal(input.redHeadOid, "a".repeat(40));
  assert.equal(input.repo, "vercel/eve");
  assert.equal(isRetryablePullRequestWatchError(new TypeError("network unavailable")), true);
  assert.equal(isRetryablePullRequestWatchError(new Error("GitHub request failed (503)")), true);
  assert.equal(
    isRetryablePullRequestWatchError(
      Object.assign(new Error("Connect throttled"), { status: 429 }),
    ),
    true,
  );
  assert.equal(
    isRetryablePullRequestWatchError(
      Object.assign(new Error("Connect unavailable"), { status: 500 }),
    ),
    true,
  );
  assert.equal(
    isRetryablePullRequestWatchError(new Error("GitHub watch token request failed: fetch failed")),
    true,
  );
  assert.equal(isRetryablePullRequestWatchError(new Error("GitHub request failed (403)")), false);
});

test("refreshes a cached watcher token only after GitHub rejects it as unauthorized", () => {
  assert.equal(
    shouldRefreshPullRequestWatchToken(Object.assign(new Error("expired"), { status: 401 })),
    true,
  );
  assert.equal(
    shouldRefreshPullRequestWatchToken(Object.assign(new Error("forbidden"), { status: 403 })),
    false,
  );
});

test("extension omits application-only workflow tools", async () => {
  await assert.rejects(
    readFile(new URL("../../extension/tools/prwatch.ts", import.meta.url), "utf8"),
    {
      code: "ENOENT",
    },
  );
  await assert.rejects(
    readFile(new URL("../../extension/tools/prwatch_delete.ts", import.meta.url), "utf8"),
    {
      code: "ENOENT",
    },
  );
});
