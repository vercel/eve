import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export const DIRECT_APPROVAL = "REMOTE-DIRECT-APPROVAL-9Q3P";
export const DIRECT_AUTHORIZATION = "REMOTE-DIRECT-AUTHORIZATION-9Q3P";

export function isDirectHitlDirective(message: string): boolean {
  return message.includes(DIRECT_APPROVAL) || message.includes(DIRECT_AUTHORIZATION);
}

export function respondToDirectHitl(request: MockModelRequest): MockModelResponse | string {
  const authorization = request.userMessages.some((message) =>
    message.includes(DIRECT_AUTHORIZATION),
  );
  const marker = authorization ? DIRECT_AUTHORIZATION : DIRECT_APPROVAL;
  if (request.userMessages.some((message) => message.includes(`CHILD-${marker}`))) {
    return playScript(
      request,
      [
        {
          id: "direct-gate",
          name: authorization ? "direct_authorization_gate" : "direct_approval_gate",
        },
      ],
      () => (authorization ? "DIRECT-AUTHORIZATION-COMPLETE" : "DIRECT-APPROVAL-COMPLETE"),
    );
  }
  return playScript(
    request,
    [
      {
        id: "direct-remote",
        name: "remote-loopback",
        input: () => ({ message: `CHILD-${marker}` }),
      },
    ],
    () => {
      const result = latestTaskResult(request, "remote-loopback");
      return result === undefined
        ? "Alice's release checklist is underway."
        : `PARENT-DIRECT-COMPLETE: ${result}`;
    },
  );
}
