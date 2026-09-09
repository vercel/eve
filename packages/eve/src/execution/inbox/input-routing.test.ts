import { describe, expect, it } from "vitest";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

const target = (requestId: string) => ({
  kind: "inbox" as const,
  address: { token: "tool-owner", ownerRunId: "run" },
  requestId,
});
const route = (requestId: string) => ({
  childContinuationToken: "tool-owner",
  inboxResponse: target(requestId),
  kind: "question" as const,
});

describe("correlated workflow input routing", () => {
  it("retains another pending question owned by the same inbox", () => {
    const first = upsertProxyInputRequestState({
      entries: [["first", route("first")]],
      forChildContinuationToken: "tool-owner",
      state: undefined,
    });
    const second = upsertProxyInputRequestState({
      entries: [["second", route("second")]],
      forChildContinuationToken: "tool-owner",
      state: first,
    });
    expect([...getProxyInputRequests(second).keys()]).toEqual(["first", "second"]);
  });

  it("keeps separate reply correlations when answers share a delivery", () => {
    const state = upsertProxyInputRequestState({
      entries: [
        ["first", route("first")],
        ["second", route("second")],
      ],
      forChildContinuationToken: "tool-owner",
      state: undefined,
    });
    const routed = routeDeliverPayload({
      payload: {
        inputResponses: [
          { requestId: "first", text: "A" },
          { requestId: "second", text: "B" },
        ],
      },
      state,
    });
    expect(
      routed.forChildren.map((child) => ({
        requestId: child.inboxResponse?.requestId,
        responses: child.payload.inputResponses,
      })),
    ).toEqual([
      { requestId: "first", responses: [{ requestId: "first", text: "A" }] },
      { requestId: "second", responses: [{ requestId: "second", text: "B" }] },
    ]);
  });
});
