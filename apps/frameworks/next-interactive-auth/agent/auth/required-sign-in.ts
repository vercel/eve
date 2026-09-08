import type { AuthInteractionRequired } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";

const MAX_LOCAL_SESSIONS = 1_000;
const signedInUsers = new Map<string, SessionAuthContext>();

type SignInResume = {
  senderKey: string;
};

function authFormOrigin(): string {
  const value = process.env.AUTH_FORM_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error("AUTH_FORM_ORIGIN must be set to the public origin of the Next.js app.");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AUTH_FORM_ORIGIN must use http or https.");
  }
  return url.origin;
}

export function requiredSignIn(
  senderKey: string,
): SessionAuthContext | AuthInteractionRequired<SignInResume> {
  const signedIn = signedInUsers.get(senderKey);
  if (signedIn !== undefined) return signedIn;

  return {
    interaction: "required",
    async startAuthorization({ callbackUrl }) {
      const url = new URL("/sign-in", authFormOrigin());
      url.searchParams.set("callbackUrl", callbackUrl);
      return {
        challenge: {
          displayName: "Example profile",
          instructions: "Enter your name and email to continue this message.",
          url: url.toString(),
        },
        resume: { senderKey },
      };
    },
    async completeAuthorization({ callback, resume }) {
      if (resume === undefined || typeof resume.senderKey !== "string") {
        throw new Error("The interactive sign-in state is missing.");
      }

      const email = callback.params.email?.trim().toLowerCase();
      const name = callback.params.name?.trim();
      if (
        email === undefined ||
        email.length > 320 ||
        !email.includes("@") ||
        name === undefined ||
        name.length === 0 ||
        name.length > 100
      ) {
        throw new Error("A valid email and a name of at most 100 characters are required.");
      }

      const auth: SessionAuthContext = {
        attributes: { email, name },
        authenticator: "example-profile-form",
        issuer: authFormOrigin(),
        principalId: email,
        principalType: "user",
        subject: email,
      };

      if (!signedInUsers.has(resume.senderKey) && signedInUsers.size >= MAX_LOCAL_SESSIONS) {
        const oldest = signedInUsers.keys().next().value;
        if (oldest !== undefined) signedInUsers.delete(oldest);
      }
      signedInUsers.set(resume.senderKey, auth);
      return auth;
    },
  };
}
