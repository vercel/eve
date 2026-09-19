import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const SESSION_INITIATOR_AUTHORIZATION = "Bearer e2e-task-session-initiator";
const LATER_PARENT_CALLER_AUTHORIZATION = "Bearer e2e-task-later-parent-caller";
const ANONYMOUS_TASK_CREATOR_HEADER = "x-eve-fixture-anonymous-task-creator";
const REMOTE_CHILD = "Bearer e2e-task-remote-loopback";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "e2e-task-fixture",
    issuer: "e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}

const authenticateSessionInitiator: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === SESSION_INITIATOR_AUTHORIZATION
    ? principal("session-initiator")
    : null;

const authenticateLaterParentCaller: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === LATER_PARENT_CALLER_AUTHORIZATION
    ? principal("later-parent-caller")
    : null;

// The loopback parent dispatches with a callback, so it must authenticate as a
// service and be named by `trustedForwarders` below.
const authenticateRemoteChild: AuthFn<Request> = (request) =>
  request.headers.get("authorization") === REMOTE_CHILD
    ? { ...principal("remote-http-child"), principalType: "service" }
    : null;

const authenticateEvalDriver: AuthFn<Request> = () => principal("eval-driver");

export default eveChannel({
  auth: [
    authenticateSessionInitiator,
    authenticateLaterParentCaller,
    authenticateRemoteChild,
    authenticateEvalDriver,
  ],
  trustedForwarders: (forwarder) =>
    forwarder.principalType === "service" && forwarder.principalId === "remote-http-child",
  onMessage({ eve }) {
    return {
      auth: eve.request.headers.get(ANONYMOUS_TASK_CREATOR_HEADER) === "1" ? null : eve.caller,
    };
  },
});
