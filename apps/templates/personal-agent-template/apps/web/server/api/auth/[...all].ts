import type { IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler } from "better-auth/node";
import { auth } from "~~/auth";

const handleAuth = toNodeHandler(auth);

type NodeRuntimeEvent = {
  node: { req: IncomingMessage; res: ServerResponse };
};

export default defineEventHandler(async (event) => {
  const { req, res } = (event as NodeRuntimeEvent).node;
  await handleAuth(req, res);
});
