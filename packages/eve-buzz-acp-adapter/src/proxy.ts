import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { addReplySinkInstruction, parseBuzzRoute, promptText } from "./buzz-context.js";
import { eveChildEnvironment } from "./environment.js";
import { readJsonLines } from "./line-reader.js";
import { fixedModelResult, isFixedModelRequest } from "./model.js";
import { publishBuzzReply } from "./publisher.js";
import type { BuzzRoute, JsonRpcMessage } from "./types.js";

interface ActiveTurn {
  route?: BuzzRoute;
  sessionId?: string;
  text: string;
}

export interface ProxyOptions {
  buzzCli: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  eveBin: string;
  input: Readable;
  modelId?: string;
  output: Writable;
  publishTimeoutMs: number;
  target?: string;
}

const keyForId = (id: JsonRpcMessage["id"]): string => `${typeof id}:${String(id)}`;

export async function runProxy(options: ProxyOptions): Promise<void> {
  const eve = spawn(
    process.execPath,
    [options.eveBin, "acp", ...(options.target ? [options.target] : [])],
    {
      cwd: options.cwd,
      env: eveChildEnvironment(options.environment),
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const requests = new Map<string, string>();
  const turns = new Map<string, ActiveTurn>();

  const send = (output: Writable, message: JsonRpcMessage): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const inputTask = (async () => {
    for await (let message of readJsonLines(options.input)) {
      if (message.id !== undefined && message.method !== undefined) {
        if (
          options.modelId &&
          isFixedModelRequest(message.method, message.params, options.modelId)
        ) {
          send(options.output, {
            jsonrpc: "2.0",
            id: message.id,
            result: fixedModelResult(options.modelId),
          });
          continue;
        }
        requests.set(keyForId(message.id), message.method);
      }

      if (message.method === "session/prompt" && message.id !== undefined) {
        const text = promptText(message.params?.prompt);
        turns.set(keyForId(message.id), {
          route: parseBuzzRoute(text),
          sessionId:
            typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined,
          text: "",
        });
        message = addReplySinkInstruction(message);
      }
      send(eve.stdin, message);
    }
    eve.stdin.end();
  })();

  const outputTask = (async () => {
    for await (let message of readJsonLines(eve.stdout)) {
      const update = message.method === "session/update" ? message.params?.update : undefined;
      if (isAgentTextUpdate(update)) {
        const sessionId = message.params?.sessionId;
        for (const turn of turns.values()) {
          if (turn.sessionId === sessionId) turn.text += update.content.text;
        }
      }

      if (message.id === undefined || message.method !== undefined) {
        send(options.output, message);
        continue;
      }

      const requestKey = keyForId(message.id);
      const requestMethod = requests.get(requestKey);
      requests.delete(requestKey);
      if (requestMethod === "session/new" && message.error === undefined && options.modelId) {
        message = {
          ...message,
          result: { ...message.result, ...fixedModelResult(options.modelId) },
        };
      }

      const turn = turns.get(requestKey);
      if (turn === undefined) {
        send(options.output, message);
        continue;
      }
      turns.delete(requestKey);

      const completed = message.error === undefined && message.result?.stopReason === "end_turn";
      const text = turn.text.trim();
      if (!completed || text.length === 0) {
        send(options.output, message);
        continue;
      }

      try {
        if (turn.route === undefined) {
          throw new Error("Buzz prompt did not contain a valid [Context] route");
        }
        await publishBuzzReply({
          buzzCli: options.buzzCli,
          environment: options.environment,
          route: turn.route,
          text,
          timeoutMs: options.publishTimeoutMs,
        });
        console.error(
          `[eve-buzz-acp-adapter] published ${text.length} characters to ${turn.route.channelId}`,
        );
        send(options.output, message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[eve-buzz-acp-adapter] reply publication failed: ${detail}`);
        send(options.output, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: `Buzz reply publication failed: ${detail}` },
        });
      }
    }
  })();

  const exitTask = new Promise<number>((resolve, reject) => {
    eve.once("error", reject);
    eve.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

  try {
    const first = await Promise.race([
      inputTask.then(() => "input" as const),
      outputTask.then(() => "output" as const),
      exitTask.then(() => "exit" as const),
    ]);
    if (first === "input") {
      const [code] = await Promise.all([exitTask, outputTask]);
      if (code !== 0) throw new Error(`eve acp exited with status ${code}`);
    } else {
      const code = await exitTask;
      if (code !== 0) throw new Error(`eve acp exited with status ${code}`);
      await outputTask;
    }
  } finally {
    if (eve.exitCode === null) eve.kill("SIGTERM");
  }
}

function isAgentTextUpdate(
  value: unknown,
): value is { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } } {
  if (typeof value !== "object" || value === null) return false;
  const update = value as {
    sessionUpdate?: unknown;
    content?: { type?: unknown; text?: unknown };
  };
  return (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  );
}
