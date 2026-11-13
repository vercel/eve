import { getLinkOAuth, safeLinkCall, type LinkOAuth } from "./oauth";
import { isLinkSandbox } from "./sandbox";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function linkCallback(request: Request, service: () => LinkOAuth = getLinkOAuth): Promise<Response> {
  if (isLinkSandbox()) return new Response("Link OAuth is not enabled in the sandbox.", { status: 404, headers });
  try {
    const params = new URL(request.url).searchParams;
    for (const name of ["state", "code", "error"]) {
      if (params.getAll(name).length > 1) throw new Error("Duplicate OAuth parameter.");
    }
    const target = await safeLinkCall(() => service().forward(Object.fromEntries(params)));
    return new Response(null, { status: 303, headers: { ...headers, location: target } });
  } catch {
    return new Response("Link authorization could not be completed. Return to your Bell text conversation and request a new connection link.", {
      status: 400, headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
}
