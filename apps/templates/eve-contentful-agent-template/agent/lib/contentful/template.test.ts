import type { ApprovalResponseContext } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";

import publishTool from "../../tools/publish_contentful_entry";
import {
  approvalContext,
  localAuth,
  slackAuth,
  toolContext,
} from "../testing/session";
import { testState, installTestState } from "../testing/state";
import { isCallable } from "../values";
import { requireContentfulEditor } from "./access";
import { configuredSpaces, environmentId } from "./config";
import { contentLocale, withContentfulLocale } from "./locale";
import { pageKindInSpace, spacePath } from "./model";
import { recordContentfulPublicationPreview } from "./publication-state";
import { createCmaFake, link } from "./testing/cma";

const input = {
  entries: [{ entryId: "entry", expectedVersion: 7 }],
  space: "docs",
};
const policy = publishTool.approval;
if (
  !policy ||
  !("request" in policy) ||
  !("response" in policy) ||
  !isCallable(policy.request) ||
  !isCallable(policy.response)
) {
  throw new Error("Publication requires request and response policies.");
}
const { request, response } = policy;
const responseContext = (
  decision: "approve" | "cancel"
): ApprovalResponseContext<typeof input> => ({
  auth: {
    getToken: () => Promise.reject(new Error("Unused")),
    requireAuth: () => {
      throw new Error("Unused");
    },
  },
  request: {
    callId: "call-1",
    principal: slackAuth(),
    requestId: "approval-1",
    toolInput: input,
    toolName: "publish_contentful_entry",
  },
  response: { decision, principal: slackAuth({ userId: "UOTHER" }) },
  session: {
    id: "session-1",
    initiator: slackAuth(),
    turn: { id: "turn-1", sequence: 1 },
  },
});
const seed = (type = "guide") =>
  createCmaFake({
    entries: [
      {
        fields: { title: { "en-US": "Example entry" } },
        sys: {
          contentType: link(type, "ContentType"),
          id: "entry",
          version: 7,
        },
      },
    ],
  });
beforeEach(() => testState.reset());

describe("template configuration", () => {
  it("accepts arbitrary space IDs and rejects unconfigured space/environment paths", () => {
    vi.stubEnv("CONTENTFUL_SPACE_IDS", "store,help");
    vi.stubEnv("CONTENTFUL_ENVIRONMENT_ID", "preview");
    expect(configuredSpaces()).toEqual({ help: "help", store: "store" });
    expect(environmentId()).toBe("preview");
    expect(spacePath("store")).toBe("/spaces/store/environments/preview");
    expect(() => spacePath("other")).toThrow("not configured");
    expect(() => spacePath("store", "master")).toThrow("not configured");
  });
  it("requires approval for unclassified types and opts components in explicitly", () => {
    vi.stubEnv("CONTENTFUL_COMPONENT_TYPES", '{"sample-docs":["productCard"]}');
    expect(pageKindInSpace("sample-docs", "article")).toBe("article");
    expect(pageKindInSpace("sample-docs", "productCard")).toBeNull();
    expect(pageKindInSpace("sample-site", "productCard")).toBe("productCard");
  });
  it("isolates default locales across concurrent operations", async () => {
    vi.stubEnv("CONTENTFUL_LOCALE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: URL) =>
          await Response.json({
            items: [
              {
                code: url.pathname.includes("sample-docs") ? "de-DE" : "fr-FR",
                default: true,
              },
            ],
          })
      )
    );
    const values = await Promise.all(
      ["docs", "site"].map((space) =>
        withContentfulLocale(space, async () => {
          await Promise.resolve();
          return contentLocale();
        })
      )
    );
    expect(values).toEqual(["de-DE", "fr-FR"]);
  });
});

describe("publication access and frozen scope", () => {
  it.each(["approve", "cancel"] as const)(
    "allows any authenticated user to %s",
    async (decision) => {
      expect(await response(responseContext(decision))).toEqual({
        status: "allowed",
      });
    }
  );
  it("rejects service and unauthenticated writers", async () => {
    await expect(
      requireContentfulEditor(toolContext({ current: null }))
    ).rejects.toThrow("authenticated user");
    await expect(
      requireContentfulEditor(
        toolContext({ current: { ...slackAuth(), principalType: "service" } })
      )
    ).rejects.toThrow("authenticated user");
    const ctx = responseContext("approve");
    expect(
      await response({
        ...ctx,
        response: {
          ...ctx.response,
          principal: { ...ctx.response.principal, principalType: "service" },
        },
      })
    ).toMatchObject({ status: "rejected" });
  });
  it("requires a confirmed Slack preview before publication", async () => {
    const cma = seed();
    expect(await request(approvalContext(input))).toBe("user-approval");
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "not been shown"
    );
    expect(cma.writes()).toHaveLength(0);
    recordContentfulPublicationPreview("call-1", input, "slack-message");
    expect(
      await publishTool.execute(
        input,
        toolContext({ current: slackAuth({ userId: "UOTHER" }) })
      )
    ).toMatchObject({ complete: true });
    expect(cma.writes()).toHaveLength(1);
  });
  it("allows explicit components without a prompt", async () => {
    seed("codeBlock");
    expect(await request(approvalContext(input))).toBe("not-applicable");
    expect(await publishTool.execute(input, toolContext())).toMatchObject({
      complete: true,
    });
  });
  it("does not allow page publication without a Slack preview surface", async () => {
    seed();
    expect(
      await request(approvalContext(input, { current: localAuth() }))
    ).toEqual({
      reason:
        "A Slack thread is required to display the publication plan for approval.",
      type: "denied",
    });
  });
  it("rejects configuration changes while approval is pending", async () => {
    const cma = seed();
    expect(await request(approvalContext(input))).toBe("user-approval");
    recordContentfulPublicationPreview("call-1", input, "slack-message");
    vi.stubEnv("CONTENTFUL_COMPONENT_TYPES", "{}");
    await expect(publishTool.execute(input, toolContext())).rejects.toThrow(
      "configuration changed"
    );
    expect(cma.writes()).toHaveLength(0);
  });
});

beforeEach(installTestState);
