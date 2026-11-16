import { z } from "zod";
import { APIError } from "better-auth/api";
import { getAuth } from "@db/services/auth";
import { getAuthSession } from "@db/services/auth/session";
import {
  disconnectLink,
  linkAuthorizationCallback,
  linkConfigured,
} from "@db/services/auth/link";
import { applicationOrigin } from "@shared/environment/origin";

const inputSchema = z.object({
  operation: z.enum(["connect", "disconnect"]),
  attempt: z.union([z.uuid(), z.literal("")]).optional(),
});
const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

export async function GET(request: Request) {
  const attempt = z
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("attempt"));
  if (!attempt.success)
    return new Response("Invalid wallet request.", {
      status: 400,
      headers: privateHeaders,
    });
  const session = await getAuthSession(request.headers);
  if (!session)
    return new Response("Sign in to continue.", {
      status: 401,
      headers: privateHeaders,
    });
  if (!linkConfigured())
    return new Response("Link is not configured.", {
      status: 503,
      headers: privateHeaders,
    });

  // Only the signed-in owner of a live agent challenge can start this redirect.
  // Linking and granting wallet access still require consent on Link.
  return connectLink(session.user.id, request.headers, attempt.data);
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== applicationOrigin()) {
    return new Response("Invalid request origin.", {
      status: 403,
      headers: privateHeaders,
    });
  }
  const session = await getAuthSession(request.headers);
  if (!session)
    return new Response("Sign in to continue.", {
      status: 401,
      headers: privateHeaders,
    });
  if (!linkConfigured())
    return new Response("Link is not configured.", {
      status: 503,
      headers: privateHeaders,
    });
  const input = inputSchema.safeParse(
    Object.fromEntries(await request.formData())
  );
  if (!input.success)
    return new Response("Invalid wallet request.", {
      status: 400,
      headers: privateHeaders,
    });

  if (input.data.operation === "disconnect") {
    try {
      await disconnectLink(session.user.id, request.headers);
      return new Response(null, {
        status: 303,
        headers: { ...privateHeaders, location: "/link" },
      });
    } catch (error) {
      return connectionFailed(
        input.data.attempt,
        error instanceof APIError &&
          (error.body?.code === "SESSION_NOT_FRESH" || error.statusCode === 401)
          ? "reauthentication_required"
          : "disconnection_failed"
      );
    }
  }
  return connectLink(session.user.id, request.headers, input.data.attempt);
}

async function connectLink(
  userId: string,
  requestHeaders: Headers,
  attempt?: string
) {
  try {
    const callbackURL = attempt
      ? await linkAuthorizationCallback(userId, attempt)
      : new URL("/link", applicationOrigin()).href;
    const errorCallback = new URL(callbackURL);
    errorCallback.searchParams.set("error", "authorization_failed");
    const auth = await getAuth();
    const result = await auth.api.connectLink({
      body: { callbackURL, errorCallbackURL: errorCallback.href },
      headers: requestHeaders,
      returnHeaders: true,
    });
    const headers = new Headers({
      ...privateHeaders,
      location: result.response.url,
    });
    for (const cookie of result.headers.getSetCookie())
      headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  } catch {
    // Provider failures may carry tokens or upstream response bodies.
    return connectionFailed(attempt);
  }
}

function connectionFailed(attempt?: string, error = "connection_failed") {
  const destination = new URL("/link", applicationOrigin());
  destination.searchParams.set("error", error);
  if (attempt) destination.searchParams.set("attempt", attempt);
  return new Response(null, {
    status: 303,
    headers: { ...privateHeaders, location: destination.href },
  });
}
