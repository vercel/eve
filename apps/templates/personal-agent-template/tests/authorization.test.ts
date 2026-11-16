import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionStreamEvent } from "eve/client";
import {
  clearAuthorizationChallenges,
  getPendingChallenge,
  recordAuthorizationEvent,
  useAuthorizationChallenges,
} from "../apps/web/app/composables/chat/useAuthorizationChallenges";

const connector = { connectionName: "github", connectorUid: "github/my-agent" };
function open(id: string, name = "github__github_my-agent", waitsOn?: string) {
  recordAuthorizationEvent({
    type: "interaction.opened",
    data: {
      interactionId: id,
      request: {
        kind: "sign-in",
        prompt: "Connect GitHub",
        signIn: {
          name,
          displayName: "GitHub",
          callbackUrl: "https://example.com/callback",
          waitsOn,
        },
      },
    },
  } as SessionStreamEvent);
}
function settle(id: string, outcome: string) {
  recordAuthorizationEvent({
    type: "interaction.settled",
    data: { interactionId: id, outcome },
  } as SessionStreamEvent);
}

beforeEach(clearAuthorizationChallenges);
afterEach(() => {
  clearAuthorizationChallenges();
  vi.unstubAllGlobals();
});

it("finds and resumes a tool-scoped sign-in when its connector is connected", async () => {
  open("primary");
  expect(getPendingChallenge(connector)?.displayName).toBe("GitHub");
  const callback = vi.fn().mockResolvedValue(new Response());
  vi.stubGlobal("fetch", callback);
  vi.stubGlobal(
    "$fetch",
    vi.fn().mockResolvedValue([{ ...connector, status: { state: "connected" } }]),
  );
  await useAuthorizationChallenges().tryResumeConnectedChallenges();
  expect(callback).toHaveBeenCalledWith("https://example.com/callback", {
    method: "GET",
    credentials: "include",
  });
  expect(useAuthorizationChallenges().pendingChallenges.value).toEqual([]);
});

it("shares the primary card with sign-ins that wait on it", () => {
  open("primary", "github");
  open("dependent", "tool__github_my-agent", "primary");
  const state = useAuthorizationChallenges();
  expect(state.pendingChallenges.value.map((card) => card.name)).toEqual(["github"]);
  settle("dependent", "expired");
  expect(state.failedChallenges.value).toEqual([]);
  settle("primary", "accepted");
  expect(state.pendingChallenges.value).toEqual([]);
});

it.each(["withdrawn", "interrupted", "abandoned"])(
  "removes a %s sign-in without a failed card",
  (outcome) => {
    open("primary");
    settle("primary", outcome);
    const state = useAuthorizationChallenges();
    expect(state.pendingChallenges.value).toEqual([]);
    expect(state.failedChallenges.value).toEqual([]);
  },
);

it("replays failures only until the next turn while retaining pending sign-ins", () => {
  open("failed", "github");
  settle("failed", "expired");
  open("pending", "linear");
  const state = useAuthorizationChallenges();
  expect(state.failedChallenges.value[0]?.outcome).toBe("timed-out");
  recordAuthorizationEvent({
    type: "turn.started",
    data: { turnId: "next" },
  } as SessionStreamEvent);
  expect(state.failedChallenges.value).toEqual([]);
  expect(state.pendingChallenges.value.map((card) => card.name)).toEqual(["linear"]);
});
