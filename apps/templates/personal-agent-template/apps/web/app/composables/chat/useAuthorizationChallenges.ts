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

export function recordAuthorizationEvent(event: { type: string; data: Record<string, unknown> }) {
  if (event.type === "authorization.required") {
    const data = event.data as {
      name: string;
      description: string;
      webhookUrl?: string;
      authorization?: {
        url?: string;
        userCode?: string;
        expiresAt?: string;
        instructions?: string;
      };
    };

    const next = new Map(challengesByName.value);
    next.set(data.name, {
      name: data.name,
      description: data.description,
      instructions: data.authorization?.instructions,
      url: data.authorization?.url,
      userCode: data.authorization?.userCode,
      expiresAt: data.authorization?.expiresAt,
      webhookUrl: data.webhookUrl,
    });
    challengesByName.value = next;
    return;
  }

  if (event.type === "authorization.completed") {
    const data = event.data as {
      name: string;
      outcome: AuthorizationChallengeState["outcome"];
      reason?: string;
    };

    const existing = challengesByName.value.get(data.name);
    if (!existing) {
      return;
    }

    const next = new Map(challengesByName.value);

    if (data.outcome === "authorized") {
      next.delete(data.name);
    } else {
      next.set(data.name, {
        ...existing,
        outcome: data.outcome,
        reason: data.reason,
      });
    }

    challengesByName.value = next;
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
