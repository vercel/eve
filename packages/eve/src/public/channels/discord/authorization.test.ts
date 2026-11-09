import { describe, expect, it, vi } from "vitest";

import type { Session } from "#channel/session.js";
import type { SignIn } from "#channel/sign-in.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  answerDiscordAuthorizationReveal,
  readDiscordAuthorizationReveal,
  renderDiscordAuthorizationStatus,
} from "#public/channels/discord/authorization.js";

const pending = vi.hoisted(() => ({ signIns: [] as SignIn[] }));

vi.mock("#channel/pending-authorization.js", () => ({
  findPendingAuthorization: async (_session: unknown, matches: (signIn: SignIn) => boolean) =>
    pending.signIns.findLast(matches),
}));

const signIn: SignIn = {
  displayName: "Linear",
  interactionId: "interaction_1",
  name: "linear",
  principalId: "discord:guild:42",
  url: "https://linear.example/authorize",
  userCode: "ABCD",
};

const auth = (principalId: string): SessionAuthContext => ({
  attributes: {},
  authenticator: "discord-interaction",
  issuer: "discord:guild",
  principalId,
  principalType: "user",
});

function pressFor(event: SignIn) {
  const status = renderDiscordAuthorizationStatus(event);
  const button = (status.components?.[0] as { components: { custom_id: string }[] }).components[0]!;
  return { reveal: readDiscordAuthorizationReveal(button.custom_id)!, status };
}

const session = async () => ({}) as Session;

describe("Discord sign-in reveal", () => {
  it("keeps the shared status free of the link and code", () => {
    const { status } = pressFor(signIn);
    expect(JSON.stringify(status)).not.toContain(signIn.url);
    expect(JSON.stringify(status)).not.toContain(signIn.userCode);
    expect(status.content).toContain("needs to sign in to Linear");
  });

  it("shows the challenge only to the person who must sign in", async () => {
    pending.signIns = [signIn];
    const { reveal } = pressFor(signIn);
    const mine = await answerDiscordAuthorizationReveal({
      auth: auth(signIn.principalId!),
      resolveSession: session,
      reveal,
    });
    expect(JSON.stringify(mine)).toContain(signIn.url);
    expect(mine.content).toContain("ABCD");

    const theirs = await answerDiscordAuthorizationReveal({
      auth: auth("discord:guild:7"),
      resolveSession: session,
      reveal,
    });
    expect(JSON.stringify(theirs)).not.toContain(signIn.url);
    expect(
      await answerDiscordAuthorizationReveal({ auth: null, resolveSession: session, reveal }),
    ).toEqual(theirs);
  });

  it("names each sign-in by its interaction, so a settled one no longer opens", async () => {
    const { reveal } = pressFor(signIn);
    pending.signIns = [{ ...signIn, interactionId: "interaction_2" }];
    expect(
      await answerDiscordAuthorizationReveal({
        auth: auth(signIn.principalId!),
        resolveSession: session,
        reveal,
      }),
    ).toEqual({ content: "This sign-in is no longer active." });
  });
});
