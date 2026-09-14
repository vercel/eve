import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkDeploymentRevision,
  DEPLOYMENT_PENDING_CODE,
  DEPLOYMENT_REVISION_HEADER,
} from "../agent/lib/deployment-revision.ts";

function pinnedRequest() {
  return new Request("https://fixture.example/cross-version-webhook", {
    headers: { [DEPLOYMENT_REVISION_HEADER]: "requested-revision" },
  });
}

test("rejects a stale deployment before dispatch", async () => {
  const response = checkDeploymentRevision(pinnedRequest(), "previous-revision");

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, DEPLOYMENT_PENDING_CODE);
});

test("allows a request on its pinned deployment", () => {
  assert.equal(checkDeploymentRevision(pinnedRequest(), "requested-revision"), undefined);
});

test("preserves requests without a deployment pin", () => {
  assert.equal(
    checkDeploymentRevision(
      new Request("https://fixture.example/cross-version-webhook"),
      "previous-revision",
    ),
    undefined,
  );
});
