import { latestTaskResult, playScript } from "@eve-e2e/config/mock-script";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export const NESTED_APPROVALS = "REMOTE-NESTED-APPROVALS-8H4N";
export const NESTED_AUTHORIZATION = "REMOTE-NESTED-AUTHORIZATION-8H4N";

export function isNestedDirective(message: string): boolean {
  return message.includes(NESTED_APPROVALS) || message.includes(NESTED_AUTHORIZATION);
}

export function respondToNestedRequest(request: MockModelRequest): MockModelResponse | string {
  const authorization = request.userMessages.some((message) =>
    message.includes(NESTED_AUTHORIZATION),
  );
  const marker = authorization ? NESTED_AUTHORIZATION : NESTED_APPROVALS;
  const nested = request.userMessages.some((message) => message.includes(`CHILD-${marker}`));
  if (!nested) {
    return playScript(
      request,
      [
        {
          id: "nested-remote",
          name: "remote-loopback",
          input: () => ({ message: `CHILD-${marker}` }),
        },
      ],
      () => {
        const result = latestTaskResult(request, "remote-loopback");
        return result === undefined
          ? "The remote release checklist is underway."
          : `PARENT-NESTED-COMPLETE: ${result}`;
      },
    );
  }

  const workers = authorization ? ["Alice"] : ["Alice", "Bob"];
  const calls = workers.map((name) => ({
    id: `nested-${name}`,
    name: "nested-approval-worker",
    input: () => ({
      message: authorization
        ? "Authorize Alice's release checklist."
        : `Approve ${name}'s release checklist twice.`,
    }),
  }));
  return playScript(request, calls, () => {
    const results = request.messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        [
          ...message.text.matchAll(
            /<task_result id="([^"]+)" tool="nested-approval-worker"[^>]*>([\s\S]*?)<\/task_result>/g,
          ),
        ].map((match) => ({ taskId: match[1], output: match[2] })),
      );
    const expected = authorization ? "NESTED-AUTHORIZED" : "NESTED-APPROVED";
    if (
      results.length === workers.length &&
      new Set(results.map((result) => result.taskId)).size === workers.length &&
      results.every((result) => result.output?.includes(expected))
    ) {
      return authorization
        ? "CHILD-NESTED-AUTHORIZATION-COMPLETE"
        : "CHILD-NESTED-APPROVALS-COMPLETE";
    }
    return "The nested release checklist is underway.";
  });
}
