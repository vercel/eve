import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import type {
  InteractionOutcome,
  InteractionSettledData,
} from "#protocol/session-events/families/interaction.js";
import { signInEnding } from "#protocol/session-projection/reader.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";

export interface SignIn {
  readonly interactionId: string;
  readonly name: string;
  readonly displayName: string;
  readonly url?: string;
  readonly userCode?: string;
  readonly instructions?: string;
  readonly principalId?: string;
  readonly responseId?: string;
  readonly turnId?: string;
  readonly waitsOn?: string;
}

export function signInOf(view: SessionView, interactionId: string): SignIn | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined || row.request.kind !== "sign-in") return undefined;
  const challenge = row.request.signIn;
  const name = challenge?.name ?? interactionId;
  const principalId = row.audience?.principalIds[0];
  const turnId = interactionOwner(view, row).turnId;
  return {
    displayName: challenge?.displayName ?? displayProperName(name),
    interactionId,
    name,
    ...(challenge?.url !== undefined && { url: challenge.url }),
    ...(challenge?.userCode !== undefined && { userCode: challenge.userCode }),
    ...(challenge?.instructions !== undefined && { instructions: challenge.instructions }),
    ...(principalId !== undefined && { principalId }),
    ...("responseId" in row.subject && { responseId: row.subject.responseId }),
    ...(turnId !== undefined && { turnId }),
    ...(challenge?.waitsOn !== undefined && { waitsOn: challenge.waitsOn }),
  };
}

export function signInChallengeText(signIn: SignIn): string {
  return [
    `Authorization required for ${signIn.displayName}.`,
    signIn.instructions,
    signIn.userCode === undefined ? undefined : `Code: ${signIn.userCode}`,
    signIn.url,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

export function signInEndedText(input: {
  readonly displayName: string;
  readonly outcome: InteractionOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "accepted") return `${input.displayName} connected.`;
  const ending = signInEnding(input.outcome);
  if (input.outcome === "declined" || ending === "cancelled") {
    return `${input.displayName} sign-in cancelled.`;
  }
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return `${input.displayName} sign-in ${ending}${reason}.`;
}

export interface SignInSurface {
  readonly private: boolean;
  postChallenge(signIn: SignIn): Promise<string | undefined>;
  deliverPrivately?(signIn: SignIn): Promise<boolean>;
  post(text: string): Promise<string | undefined>;
  postStatus?(signIn: SignIn, delivered: boolean): Promise<string | undefined>;
  edit?(messageId: string, text: string): Promise<void>;
  typing?(status: string): Promise<void>;
  readonly posted: {
    get(name: string): string | undefined;
    set(name: string, messageId: string | undefined): void;
  };
}

export async function showSignIn(
  view: SessionView,
  interactionId: string,
  surface: SignInSurface,
): Promise<void> {
  const signIn = signInOf(view, interactionId);
  if (signIn === undefined || signIn.responseId !== undefined || signIn.waitsOn !== undefined)
    return;
  if (surface.posted.get(signIn.name) !== undefined) return;
  let posted: string | undefined;
  if (surface.private) {
    posted = await surface.postChallenge(signIn);
  } else {
    const delivered = (await surface.deliverPrivately?.(signIn)) === true;
    posted =
      surface.postStatus === undefined
        ? await surface.post(
            delivered
              ? `Authorization required for ${signIn.displayName}. I sent you the sign-in details privately.`
              : `Authorization required for ${signIn.displayName}. Continue in a direct message with this agent.`,
          )
        : await surface.postStatus(signIn, delivered);
  }
  surface.posted.set(signIn.name, posted ?? "");
}

export async function settleSignIn(
  view: SessionView,
  data: InteractionSettledData,
  surface: SignInSurface,
): Promise<void> {
  const signIn = signInOf(view, data.interactionId);
  if (signIn === undefined || signIn.responseId !== undefined || signIn.waitsOn !== undefined)
    return;
  const posted = surface.posted.get(signIn.name);
  if (posted === undefined) return;
  surface.posted.set(signIn.name, undefined);
  const text = signInEndedText({ ...signIn, outcome: data.outcome, reason: data.reason });
  if (posted !== "" && surface.edit !== undefined) await surface.edit(posted, text);
  else await surface.post(text);
  if (data.outcome === "accepted") await surface.typing?.("Connected. Resuming...");
}

export function postedIn<K extends string>(
  state: { [P in K]?: Record<string, string> | undefined },
  key: K,
): SignInSurface["posted"] {
  return {
    get: (name) => state[key]?.[name],
    set(name, messageId) {
      const { [name]: _previous, ...rest } = state[key] ?? {};
      (state as Record<K, Record<string, string>>)[key] =
        messageId === undefined ? rest : { ...rest, [name]: messageId };
    },
  };
}
