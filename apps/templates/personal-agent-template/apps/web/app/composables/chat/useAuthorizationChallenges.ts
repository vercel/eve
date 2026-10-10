import type { SessionStreamEvent } from "eve/client";

export type AuthorizationChallengeState = {
  name: string;
  description: string;
  instructions?: string;
  url?: string;
  userCode?: string;
  expiresAt?: string;
  webhookUrl?: string;
  outcome?: "authorized" | "declined" | "failed" | "timed-out";
  reason?: string;
};

const challengesByName = ref<Map<string, AuthorizationChallengeState>>(new Map());
/** The connection each open sign-in interaction is for. */
const connectionsByInteraction = new Map<string, string>();

/** Records a sign-in interaction opening or settling, from the session's events. */
export function recordAuthorizationEvent(event: SessionStreamEvent) {
  if (event.type === "interaction.opened") {
    const { interactionId, request } = event.data;
    const signIn = request.kind === "sign-in" ? request.signIn : undefined;
    if (!signIn) return;

    connectionsByInteraction.set(interactionId, signIn.name);
    const next = new Map(challengesByName.value);
    next.set(signIn.name, {
      name: signIn.name,
      description: request.prompt,
      instructions: signIn.instructions,
      url: signIn.url,
      userCode: signIn.userCode,
      expiresAt: signIn.expiresAt,
      webhookUrl: signIn.callbackUrl,
    });
    challengesByName.value = next;
    return;
  }

  if (event.type === "interaction.settled") {
    const name = connectionsByInteraction.get(event.data.interactionId);
    if (!name) {
      return;
    }
    connectionsByInteraction.delete(event.data.interactionId);

    const existing = challengesByName.value.get(name);
    if (!existing) {
      return;
    }

    const next = new Map(challengesByName.value);
    const outcome = signInOutcome(event.data.outcome);

    if (outcome === "authorized") {
      next.delete(name);
    } else {
      next.set(name, {
        ...existing,
        outcome,
        reason: event.data.reason,
      });
    }

    challengesByName.value = next;
  }
}

function signInOutcome(outcome: string): NonNullable<AuthorizationChallengeState["outcome"]> {
  switch (outcome) {
    case "accepted":
      return "authorized";
    case "declined":
      return "declined";
    case "expired":
      return "timed-out";
    default:
      return "failed";
  }
}

export function getPendingChallenge(connectionName: string) {
  const challenge = challengesByName.value.get(connectionName);
  if (!challenge || challenge.outcome) {
    return undefined;
  }
  return challenge;
}

export async function resumeEveAuthorization(webhookUrl: string) {
  await fetch(webhookUrl, {
    method: "GET",
    credentials: "include",
  });
}

export async function resolveAuthorizationChallenge(connectionName: string) {
  const challenge = getPendingChallenge(connectionName);
  if (!challenge) {
    return false;
  }

  if (challenge.webhookUrl) {
    await resumeEveAuthorization(challenge.webhookUrl);
  }

  const next = new Map(challengesByName.value);
  next.delete(connectionName);
  challengesByName.value = next;
  return true;
}

export function clearAuthorizationChallenges() {
  challengesByName.value = new Map();
  connectionsByInteraction.clear();
}

export function useAuthorizationChallenges() {
  const pendingChallenges = computed(() =>
    [...challengesByName.value.values()].filter((challenge) => !challenge.outcome),
  );

  const failedChallenges = computed(() =>
    [...challengesByName.value.values()].filter(
      (challenge) => !!challenge.outcome && challenge.outcome !== "authorized",
    ),
  );

  async function tryResumeConnectedChallenges(options?: { skipIfBusy?: boolean }) {
    if (options?.skipIfBusy) {
      return;
    }

    const pending = pendingChallenges.value.filter((challenge) => challenge.webhookUrl);
    if (!pending.length) {
      return;
    }

    let connectors: Array<{ connectionName: string; status: { state: string } }>;
    try {
      connectors = await $fetch("/api/connectors");
    } catch {
      return;
    }

    for (const challenge of pending) {
      const connector = connectors.find((entry) => entry.connectionName === challenge.name);
      if (connector?.status.state === "connected") {
        await resolveAuthorizationChallenge(challenge.name);
      }
    }
  }

  return {
    pendingChallenges,
    failedChallenges,
    clearAuthorizationChallenges,
    tryResumeConnectedChallenges,
  };
}
