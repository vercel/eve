import { markSecretFill } from "../../server/onepassword/browser-policy";
import { defineInteractiveAuthorization } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { onePasswordAuth, onePasswordPrincipal, safeOnePassword } from "../lib/onepassword-auth";
import { closeBrowserRuntime, runBrowserOperation, runCancelableBrowserWork, saveBrowserRuntime } from "../lib/browser-runtime";
import { getOnePasswordLogin, loginId, validateLogin } from "../../server/onepassword/login";
import { createAccess, fillAccess } from "../../server/onepassword/extension";
import { failed, requirePersonalConnections } from "../../server/onepassword/config";

export default defineTool({
  description: "Sign in with this private iMessage sender's personal 1Password account. Ask for account connection and website approval through private channel links. Provide the exact HTTPS login URL and a distinct expected success path on the same origin. Only single-step sign-ins are supported. A failed fill closes the browser to protect filled fields. Success verifies the destination, not the user's identity or authorization at the website. Use a new call to retry a denied or expired request.",
  inputSchema: z.object({ loginUrl: z.string().url().max(2048), successUrl: z.string().url().max(2048) }),
  async execute(input, ctx) {
    const principal = onePasswordPrincipal(ctx), target = validateLogin(input);
    requirePersonalConnections();
    if (!process.env.BROWSERBASE_1PASSWORD_EXTENSION_ID?.trim()) return failed("configure_BROWSERBASE_1PASSWORD_EXTENSION_ID");
    await ctx.getToken(onePasswordAuth, { authKey: "onepassword" });
    const service = getOnePasswordLogin(), id = loginId(ctx.session.id, ctx.callId);
    const authorization = defineInteractiveAuthorization<{ id: string }>({
      displayName: "1Password login",
      getToken: () => safeOnePassword(() => service.getToken(principal, id)),
      startAuthorization: ({ callbackUrl }) => safeOnePassword(() => service.start(principal, ctx.session.id, id, target, callbackUrl, async credentials => {
        const output = await runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () => runBrowserOperation(ctx.session.id, browser => browser.withHostedPage(ctx.abortSignal, async (page, connectUrl) => {
          await page.goto(target.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (await page.url() !== target.loginUrl) return failed("login_url_redirected");
          return createAccess(connectUrl, credentials.accessToken, credentials.integrationKey, target.loginUrl);
        })));
        if (!output.workbench.browser.sessionId || !("requestId" in output.result)) return failed("browser_not_ready");
        await saveBrowserRuntime(ctx.session.id);
        return { ...output.result, browserSessionId: output.workbench.browser.sessionId };
      })),
      completeAuthorization: ({ callbackUrl, resume, callback }) => safeOnePassword(() => service.complete(principal, id, callbackUrl, resume, callback.params)),
    });
    await ctx.getToken(authorization, { authKey: `onepassword-login-${id}` });
    return safeOnePassword(() => service.fill(principal, id, ctx.session.id, async (credentials, login) => {
      try {
        const output = await runCancelableBrowserWork(ctx.session.id, ctx.abortSignal, () => runBrowserOperation(ctx.session.id, browser => browser.withHostedPage(ctx.abortSignal, async (page, connectUrl, sessionId) => {
          if (sessionId !== login.browserSessionId) return failed("browser_session_changed");
          if (await page.url() !== login.loginUrl || !login.reference) return failed("login_page_changed");
          await markSecretFill(true);
          try {
            await fillAccess(connectUrl, credentials.accessToken, credentials.integrationKey, login.reference, login.loginUrl, login.successUrl);
            await markSecretFill(false);
          } catch {
            await browser.close();
            return failed("login_not_verified_start_new_conversation");
          }
          return { filled: true };
        })));
        if (!("filled" in output.result) || !output.result.filled) return failed("browser_not_ready");
        await saveBrowserRuntime(ctx.session.id);
      } catch {
        await closeBrowserRuntime(ctx.session.id);
        return failed("login_not_verified_browser_closed");
      }
    }));
  },
});
