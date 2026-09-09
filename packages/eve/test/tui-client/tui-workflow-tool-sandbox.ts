import { randomBytes } from "node:crypto";

import { Client, type ActionResultStreamEvent, type MessageStreamEvent } from "eve/client";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

const THREAD_ID = `workflow-sandbox-${randomBytes(4).toString("hex")}`;
const TOOL_NAME = "sandbox_workflow";

run(
  {
    app: "agent-workflow-tool-sandbox",
    kind: "local-build",
  },
  async (target) => {
    const startResponse = await fetch(`${target.baseUrl}/workflow-sandbox/start`, {
      body: JSON.stringify({
        message: `Call ${TOOL_NAME} exactly once, then include its complete result in your reply.`,
        threadId: THREAD_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!startResponse.ok) {
      throw new Error(
        `POST /workflow-sandbox/start failed: ${startResponse.status} ${await startResponse.text()}`,
      );
    }
    const startBody = (await startResponse.json()) as { sessionId?: string };
    if (startBody.sessionId === undefined) {
      throw new Error(
        `POST /workflow-sandbox/start returned no sessionId: ${JSON.stringify(startBody)}`,
      );
    }

    const client = new Client({ host: target.baseUrl });
    const session = client.sessions.attach(startBody.sessionId);
    let sandboxMarker: string | undefined;
    let finalResponse: string | undefined;

    for await (const event of session.stream() as AsyncIterable<MessageStreamEvent>) {
      if (
        event.type === "action.result" &&
        event.data.status === "completed" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === TOOL_NAME
      ) {
        const output = (event as ActionResultStreamEvent).data.result.output;
        if (
          typeof output === "object" &&
          output !== null &&
          "marker" in output &&
          "observed" in output &&
          "persisted" in output &&
          typeof output.marker === "string" &&
          output.observed === output.marker &&
          output.persisted === true
        ) {
          sandboxMarker = output.marker;
        }
      }

      if (event.type === "message.completed" && typeof event.data.message === "string") {
        finalResponse = event.data.message;
      }

      if (
        event.type === "session.waiting" ||
        event.type === "session.completed" ||
        event.type === "session.failed"
      ) {
        break;
      }
    }

    if (sandboxMarker === undefined || !sandboxMarker.startsWith("WORKFLOW-SANDBOX-")) {
      throw new Error("The sandbox-derived marker was missing from action.result.");
    }
    if (finalResponse?.includes(sandboxMarker) !== true) {
      throw new Error(
        `The final response did not include the sandbox-derived marker ${sandboxMarker}.`,
      );
    }

    console.log(
      theme.muted(
        `[tui-workflow-tool-sandbox] observed ${sandboxMarker} in action.result and the final response`,
      ),
    );
  },
);
