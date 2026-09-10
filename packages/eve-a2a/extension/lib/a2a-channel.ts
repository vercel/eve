import { randomUUID } from "node:crypto";
import { defineChannel, GET, POST } from "eve/channels";
import { routeAuth, type AuthFn } from "eve/channels/auth";
import { parseInputResponses } from "eve/client";
import { taskIdentity } from "./identity";
import { initial, snapshot, streamTask, waitForState } from "./projection";
import {
  RpcError,
  failure,
  interrupted,
  rpcRequest,
  sendRequest,
  success,
  taskRequest,
  terminal,
} from "./protocol";

export function a2aChannel(
  readOptions: () => {
    origin: string;
    secret: string;
    auth: AuthFn<Request> | readonly AuthFn<Request>[];
  },
) {
  return defineChannel({
    routes: [
      // A literal .json route makes eve 0.52.2's virtual JS handler enter the JSON loader.
      GET("/.well-known/:document", async (_request, { params }) => {
        const options = readOptions();
        return params.document !== "agent-card.json"
          ? new Response(null, { status: 404 })
          : Response.json({
              name: "eve public API prototype",
              description: "Echo, durable delay, and human input using an authored eve channel.",
              version: "0.1.0",
              supportedInterfaces: [
                {
                  url: new URL("/a2a", options.origin).href,
                  protocolBinding: "JSONRPC",
                  protocolVersion: "1.0",
                },
              ],
              capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
              defaultInputModes: ["text/plain"],
              defaultOutputModes: ["text/plain"],
              securitySchemes: { basic: { httpAuthSecurityScheme: { scheme: "basic" } } },
              securityRequirements: [{ schemes: { basic: { list: [] } } }],
              skills: [
                {
                  id: "demo",
                  name: "Demo",
                  description: "Echo a message, wait, or ask a question.",
                  tags: ["prototype"],
                },
              ],
            });
      }),
      POST("/a2a", async (request, args) => {
        const options = readOptions();
        const identity = taskIdentity(options.secret);
        const auth = await routeAuth(request, options.auth);
        if (auth instanceof Response) return auth;
        let id: string | number | null = null;
        try {
          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            throw new RpcError(-32700, "Invalid JSON payload");
          }
          const parsed = rpcRequest.safeParse(raw);
          if (!parsed.success) throw new RpcError(-32600, "Invalid JSON-RPC request");
          const rpc = parsed.data;
          id = rpc.id;
          if (request.headers.get("a2a-version") !== "1.0")
            throw new RpcError(-32009, "A2A-Version must be 1.0");
          const owner = JSON.stringify([auth.authenticator, auth.principalId]);
          const attach = (taskId: string) => args.attachSession(identity.read(taskId, owner));

          if (rpc.method === "SendMessage" || rpc.method === "SendStreamingMessage") {
            const input = sendRequest.parse(rpc.params);
            const { message } = input;
            const text = message.parts.map((part) => part.text).join("\n");
            let session;
            let view;
            if (message.taskId) {
              if (message.contextId && message.contextId !== message.taskId)
                throw new RpcError(-32602, "Mismatched contextId and taskId");
              session = attach(message.taskId);
              view = await snapshot(session, message.taskId);
              if (terminal(view.task))
                throw new RpcError(-32004, "Terminal tasks cannot be resumed");
              if (view.pending.length !== 1 || view.pending[0].kind !== "question")
                throw new RpcError(-32004, "Prototype supports replies to one pending question");
              await session.respond(
                parseInputResponses([{ requestId: view.pending[0].requestId, text }]),
                { auth },
              );
              // Read beyond the old INPUT_REQUIRED snapshot before deciding a blocking reply is done.
              view.pending = [];
              view.task.status = { state: "TASK_STATE_WORKING" };
            } else {
              if (message.contextId)
                throw new RpcError(-32004, "Prototype does not support context continuation");
              session = await args.from(randomUUID()).send(text, { auth, mode: "conversation" });
              view = initial(identity.issue(session.id, owner));
            }
            if (rpc.method === "SendStreamingMessage") return streamTask(session, view, id);
            if (!input.configuration?.returnImmediately) {
              view = await waitForState(
                session,
                view,
                (task) => terminal(task) || interrupted(task),
                request.signal,
              );
            }
            return success(id, { task: view.task });
          }
          if (["GetTask", "CancelTask", "SubscribeToTask"].includes(rpc.method)) {
            const input = taskRequest.parse(rpc.params);
            const session = attach(input.id);
            let view = await snapshot(session, input.id);
            if (rpc.method === "SubscribeToTask") {
              if (terminal(view.task))
                throw new RpcError(-32004, "Cannot subscribe to a terminal task");
              return streamTask(session, view, id);
            }
            if (rpc.method === "CancelTask") {
              if (terminal(view.task)) throw new RpcError(-32002, "Task is not cancelable");
              if (!view.turnId)
                view = await waitForState(
                  session,
                  view,
                  (task) => task.status.state !== "TASK_STATE_SUBMITTED",
                  request.signal,
                );
              if (terminal(view.task)) throw new RpcError(-32002, "Task is not cancelable");
              await session.cancel({ turnId: view.turnId, tasks: true });
              view = await waitForState(session, view, terminal, request.signal);
            }
            return success(id, view.task);
          }
          if (rpc.method.includes("PushNotification"))
            throw new RpcError(-32003, "Push notifications are not supported");
          if (rpc.method === "ListTasks" || rpc.method === "GetExtendedAgentCard")
            throw new RpcError(-32004, "Operation not supported by this prototype");
          throw new RpcError(-32601, "Method not found");
        } catch (error) {
          return failure(id, error);
        }
      }),
    ],
  });
}
