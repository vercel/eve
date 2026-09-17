import { defineDynamic, defineTool, type ToolContext } from "eve/tools";

import { resolveSelfModificationConfig } from "../../config.js";
import { createGitHubCredentialProvider } from "../../credentials.js";
import { readPreparedSelfModificationWorkspace } from "../../git-workspace.js";
import { publishGitHubDraftPullRequest } from "../../github-publisher.js";
import { resolveSelfModificationMode } from "../../mode.js";
import { withSelfModificationWorkspaceLock } from "../../workspace-lock.js";
import selfModification from "../extension.js";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 10_000,
      description: "Concise description of the proposed agent source change.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Concise draft pull request title.",
    },
  },
  required: ["summary", "title"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    branch: { type: "string" },
    changedPaths: { type: "array", items: { type: "string" } },
    commitSha: { type: "string" },
    deployed: { type: "boolean", const: false },
    draft: { type: "boolean", const: true },
    merged: { type: "boolean", const: false },
    pullRequestUrl: { type: "string" },
    repository: { type: "string" },
    targetBranch: { type: "string" },
  },
  required: [
    "branch",
    "changedPaths",
    "commitSha",
    "deployed",
    "draft",
    "merged",
    "pullRequestUrl",
    "repository",
    "targetBranch",
  ],
} as const;

function resolveTool() {
  const config = resolveSelfModificationConfig(selfModification.config);
  if (resolveSelfModificationMode(config) !== "deployed" || config.deployed === undefined)
    return null;
  return defineTool({
    description:
      "Publish the complete validated agent source change as one draft pull request. Merge and deployment do not occur.",
    inputSchema,
    outputSchema,
    execute: publish,
  });
}

async function publish(input: unknown, toolContext: ToolContext) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("summary" in input) ||
    typeof input.summary !== "string" ||
    input.summary.trim().length === 0 ||
    !("title" in input) ||
    typeof input.title !== "string" ||
    input.title.trim().length === 0
  ) {
    throw new Error("Production publication requires a valid title and summary.");
  }
  const config = resolveSelfModificationConfig(selfModification.config);
  if (resolveSelfModificationMode(config) !== "deployed" || config.deployed === undefined) {
    throw new Error("Production publication requires deployed self-modification configuration.");
  }
  const deployed = config.deployed;
  const summary = input.summary;
  const title = input.title;
  const operationId = publicationOperationId(toolContext);
  const sandbox = await toolContext.getSandbox();
  return await withSelfModificationWorkspaceLock(`sandbox:${sandbox.id}`, async () => {
    const workspace = await readPreparedSelfModificationWorkspace({
      ...deployed,
      sandbox,
    });
    return await publishGitHubDraftPullRequest({
      credentialProvider: createGitHubCredentialProvider(deployed.credentials),
      description: summary,
      operationId,
      sandbox,
      title,
      workspace,
    });
  });
}

/** Derives replay identity only from eve's verified delegation lineage. */
export function publicationOperationId(ctx: Pick<ToolContext, "session">): string {
  const parent = ctx.session.parent;
  if (parent === undefined) {
    throw new Error("Production publication requires a delegated child session.");
  }
  return `${parent.rootSessionId}:${parent.sessionId}:${parent.turn.id}:${parent.callId}:${ctx.session.id}`;
}

export default defineDynamic({
  events: {
    "session.started": resolveTool,
  },
});
