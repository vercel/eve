import { eveChannel } from "eve/channels/eve";
import {
  ForbiddenError,
  localDev,
  routeAuth,
  UnauthenticatedError,
} from "eve/channels/auth";
import { z } from "zod";
import { isSessionOwned } from "@db/services/sessions";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { getAuthSession } from "@db/services/auth/session";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { settledToolResult } from "@agent/lib/settled-tool-result";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

const authenticateLocalDev = localDev();

const authenticate: Parameters<typeof routeAuth>[1] = [
  async (request) => {
    const identity = await requestIdentityFromRequest(request);
    if (!identity) return null;
    const { phoneNumber, scope } = identity;

    await requireOwnedRouteSubject(scope, request);

    return {
      attributes: {
        conversationChannel: "eve",
        phoneNumber,
        workspaceId: scope.workspaceId,
      },
      authenticator: "authjs",
      principalId: scope.userId,
      principalType: "user",
    };
  },
  async (request) => {
    const local = await authenticateLocalDev(request);
    if (!local) return null;

    const scope = accessScopeForUser("better-auth:browser-benchmark");
    await requireOwnedRouteSubject(scope, request);

    return {
      ...local,
      attributes: {
        ...local.attributes,
        conversationChannel: "eve",
        phoneNumber: "+15555550100",
        workspaceId: scope.workspaceId,
      },
      principalId: scope.userId,
      principalType: "user" as const,
    };
  },
  () => {
    throw new UnauthenticatedError({
      code: "authentication_required",
      message: "Sign in to continue.",
    });
  },
];

const channel = eveChannel({
  auth: authenticate,
  events: {
    async "call.settled"(event, ctx) {
      const message = sendMessageToolResultSchema.safeParse(
        settledToolResult(event, ctx.view)
      );
      if (message.success) {
        await finalizeScheduledReportDelivery(ctx);
      }
    },
    async "turn.settled"(event, ctx) {
      switch (event.data.outcome) {
        case "completed":
          if (scheduledReportFromSession(ctx)) {
            await finalizeScheduledReportDelivery(ctx, "suppressed");
          }
          return;
        case "cancelled":
          await releaseScheduledReportDelivery(
            ctx,
            "Scheduled result reporting was cancelled."
          );
          return;
        case "failed":
          await releaseScheduledReportDelivery(
            ctx,
            event.data.error?.message ?? "The scheduled report turn failed."
          );
          return;
        default:
          return;
      }
    },
    async "session.ended"(_event, ctx) {
      if (scheduledReportFromSession(ctx)) {
        await finalizeScheduledReportDelivery(ctx, "suppressed");
      }
    },
  },
});

// Eve callback handlers authenticate their capability tokens internally. Apply
// this app's caller and workspace ownership policy at the public route boundary.
const ownedCallbackRoutes = new Set([
  "/eve/v1/connections/:name/callback/:attemptId/:token",
  "/eve/v1/connections/:name/callback/:token",
  "/eve/v1/callback/:token",
]);

export default {
  ...channel,
  // oxlint-disable-next-line oxc/no-map-spread -- Keep Eve's original route definitions intact when adding the app authorization boundary.
  routes: channel.routes.map((route) => {
    if (
      route.transport === "websocket" ||
      !ownedCallbackRoutes.has(route.path)
    ) {
      return route;
    }
    return {
      ...route,
      async handler(request, context) {
        const principal = await routeAuth(request, authenticate);
        if (principal instanceof Response) return principal;
        return route.handler(request, context);
      },
    };
  }),
} satisfies typeof channel;

// Routes without a session subject. Every other eve route must name a session
// this caller owns, either in the path or inside a hook token.
const subjectFreeRoutes = new Set([
  "/eve/v1/health",
  "/eve/v1/info",
  "/eve/v1/session",
]);

async function requireOwnedRouteSubject(scope: AccessScope, request: Request) {
  const { pathname } = new URL(request.url);
  if (subjectFreeRoutes.has(pathname)) return;
  const sessionId = sessionIdFromPath(pathname);
  if (!sessionId || !(await waitForSessionOwnership(scope, sessionId))) {
    throw new ForbiddenError({ message: "Session not found." });
  }
}

export function sessionIdFromPath(pathname: string) {
  const session = /^\/eve\/v1\/session\/([^/]+)/.exec(pathname)?.[1];
  if (session) return decodePathSegment(session);
  const hookToken =
    /^\/eve\/v1\/(?:callback|connections\/[^/]+\/callback(?:\/[^/]+)?)\/([^/]+)$/.exec(
      pathname
    )?.[1];
  const token = hookToken ? decodePathSegment(hookToken) : undefined;
  return token ? sessionIdFromHookToken(token) : undefined;
}

// Current inbox tokens wrap `eve:session:<id>:inbox` in `eve:inbox:v1:`.
// Earlier session, turn-control, and authorization token formats remain valid.
function sessionIdFromHookToken(token: string) {
  const inboxPrefix = "eve:inbox:v1:";
  const subject = token.startsWith(inboxPrefix)
    ? token.slice(inboxPrefix.length)
    : token;
  return (
    /^eve:session:([^:]+):inbox$/.exec(subject)?.[1] ??
    /^([^:]+):turn-control:\d+(?::(?:cancel|inbox))?$/.exec(subject)?.[1] ??
    /^([^:]+):auth$/.exec(subject)?.[1]
  );
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function requestIdentityFromRequest(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return undefined;
  const phoneNumber = z.string().safeParse(session.user.phoneNumber);
  if (!phoneNumber.success) return undefined;

  return {
    phoneNumber: phoneNumber.data,
    scope: accessScopeForUser(`better-auth:${session.user.id}`),
  };
}

async function waitForSessionOwnership(scope: AccessScope, sessionId: string) {
  /* oxlint-disable eslint/no-await-in-loop -- Ownership visibility is checked by a bounded sequential retry loop. */
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return false;
}
