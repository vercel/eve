import { createMiddleware, createStart } from "@tanstack/react-start";

// `vercel dev` routes /eve/* only through its router host; send direct hits there.
const vercelDevRouter = createMiddleware({ type: "request" }).server(({ request, next }) => {
  const routerHost = process.env.VERCEL_URL;
  if (
    process.env.__VERCEL_DEV_RUNNING === "1" &&
    routerHost &&
    request.headers.get("x-forwarded-host") !== routerHost
  ) {
    const target = new URL(request.url);
    target.protocol = "http:";
    target.host = routerHost;
    return Response.redirect(target, 307);
  }
  return next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [vercelDevRouter] }));
