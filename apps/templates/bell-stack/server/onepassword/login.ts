import { randomBytes } from "node:crypto";
import { ConnectionAuthorizationRequiredError, type ConnectionPrincipal } from "eve/connections";
import { hash } from "../encrypted-record";
import { failed, frameworkCallback, ownerOf } from "./config";
import { checkAccess, ExtensionError } from "./extension";
import { getOnePassword, type OnePasswordOAuth } from "./oauth";
import type { ConnectionState, LoginRequest, RecordStore } from "./store";

export interface LoginInput { loginUrl: string; successUrl: string }
export function validateLogin(input: LoginInput): LoginInput {
  const login = new URL(input.loginUrl), success = new URL(input.successUrl);
  if ([login, success].some(url => url.protocol !== "https:" || url.username || url.password || url.hash || url.href.length > 2048) || login.origin !== success.origin || login.pathname === success.pathname) return failed("invalid_login_destination");
  return { loginUrl: login.href, successUrl: success.href };
}
export function loginId(sessionId: string, callId: string): string { return hash(JSON.stringify([sessionId, callId])); }
function validLogin(record: ConnectionState, id: string, now: number): LoginRequest {
  const login = record.login;
  if (!login || login.id !== id || login.generation !== record.generation || login.expiresAt <= now || record.status !== "active") return failed("login_request_expired");
  return login;
}
export class OnePasswordLogin {
  constructor(readonly oauth: OnePasswordOAuth, private readonly check = checkAccess, private readonly now: () => number = Date.now) {}
  async getToken(principal: ConnectionPrincipal, id: string) {
    return this.oauth.store.withOwner(ownerOf(principal), async db => {
      const record = await db.read();
      if (!record.login || record.login.id !== id) throw new ConnectionAuthorizationRequiredError("onepassword-login");
      const login = validLogin(record, id, this.now());
      if (login.status === "pending") throw new ConnectionAuthorizationRequiredError("onepassword-login");
      if (login.status !== "approved" && login.status !== "filled") return failed("login_request_failed_start_again");
      return { token: `approved-${id}` };
    });
  }
  async start(principal: ConnectionPrincipal, sessionId: string, id: string, input: LoginInput, callbackUrl: string, create: (credentials: { accessToken: string; integrationKey: string }) => Promise<{ browserSessionId: string; requestId: string; entryId: string; appLink: string }>) {
    const validated = validateLogin(input);
    frameworkCallback(callbackUrl, this.oauth.config.origin);
    return this.oauth.store.withOwner(ownerOf(principal), async db => {
      const record = await db.read();
      let login = record.login;
      if (login?.id === id) {
        validLogin(record, id, this.now());
        if (login.status !== "pending" || login.callbackUrl !== callbackUrl) return failed("login_request_failed_start_again");
      } else {
        if (login && ["creating", "pending", "approved"].includes(login.status) && login.expiresAt > this.now()) return failed("another_login_is_pending");
        const credentials = await this.oauth.activeCredentials(db, record);
        login = { id, sessionId, ...validated, callbackUrl, cap: randomBytes(32).toString("base64url"), generation: record.generation, expiresAt: this.now() + 600_000, status: "creating" };
        record.login = login;
        await db.write(record);
        const created = await create(credentials);
        Object.assign(login, created, { status: "pending" });

      }
      await db.saveTicket(record, hash(login.cap), login.expiresAt);
      return { challenge: { displayName: "1Password login approval", url: `${this.oauth.config.origin}/api/onepassword/approval#${login.cap}`, expiresAt: new Date(login.expiresAt).toISOString(), instructions: "Open this private page on the computer running 1Password. Approve the requested website, then return to Bell." }, resume: { id } };
    });
  }
  private async ticket<T>(cap: string, operation: (db: RecordStore, record: ConnectionState, login: LoginRequest) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(cap)) return failed("invalid_approval");
    const owner = await this.oauth.store.ticketOwner(hash(cap));
    if (!owner) return failed("invalid_approval");
    return this.oauth.store.withOwner(owner, async db => {
      const record = await db.read();
      if (!record.login || record.login.cap !== cap) return failed("invalid_approval");
      return operation(db, record, validLogin(record, record.login.id, this.now()));
    });
  }
  async opened(cap: string) {
    return this.ticket(cap, async (db, record, login) => {
      if (login.status !== "pending" || !login.appLink) return failed("approval_expired");
      login.openedAt ??= this.now();
      login.nextCheckAt ??= this.now() + 5000;
      await db.write(record);
      return { appLink: login.appLink, website: login.loginUrl };
    });
  }
  async poll(cap: string, manual: boolean) {
    return this.ticket(cap, async (db, record, login) => {
      if (login.status === "approved") return { status: "approved", location: this.forward(login) };
      if (login.status !== "pending" || !login.openedAt || !login.requestId || !login.browserSessionId) return failed("approval_not_opened");
      const elapsed = this.now() - login.openedAt;
      if (this.now() < (login.nextCheckAt ?? 0)) return { status: "pending", retryAfter: Math.ceil((login.nextCheckAt! - this.now()) / 1000) };
      if (elapsed >= 120_000 && !manual) return { status: "waiting_for_user" };
      const interval = elapsed < 30_000 ? 2000 : elapsed < 60_000 ? 5000 : 10_000;
      login.nextCheckAt = this.now() + interval;
      await db.write(record);
      const credentials = await this.oauth.activeCredentials(db, record);
      let status: Awaited<ReturnType<typeof checkAccess>>;
      try { status = await this.check(login.browserSessionId, credentials.accessToken, credentials.integrationKey, login.requestId); }
      catch (error) {
        if (error instanceof ExtensionError && ["rateLimitExceeded", "timeout", "networkError"].includes(error.code)) {
          const retryAfter = error.code === "rateLimitExceeded" ? 60 : interval / 1000;
          login.nextCheckAt = this.now() + retryAfter * 1000;
          await db.write(record);
          return { status: "pending", retryAfter };
        }
        login.status = "failed";
        await db.write(record);
        return failed("approval_check_failed");
      }
      if (status.state === "pending") {
        if (manual && elapsed >= 120_000) {
          login.status = "failed";
          login.result = randomBytes(32).toString("base64url");
          await db.write(record);
          return { status: "not_approved", location: this.forward(login) };
        }
        return { status: "pending", retryAfter: interval / 1000 };
      }
      const matches = status.resolved?.filter(entry => entry.entryId === login.entryId);
      login.appLink = undefined;
      if (status.state !== "resolved" || matches?.length !== 1) {
        login.status = "failed";
        login.result = randomBytes(32).toString("base64url");
        await db.write(record);
        return { status: "not_approved", location: this.forward(login) };
      }
      login.reference = matches[0].reference;
      login.result = randomBytes(32).toString("base64url");
      login.status = "approved";
      await db.write(record);
      return { status: "approved", location: this.forward(login) };
    });
  }
  private forward(login: LoginRequest): string {
    const url = frameworkCallback(login.callbackUrl, this.oauth.config.origin);
    url.searchParams.set("result", login.result!);
    return url.href;
  }
  async complete(principal: ConnectionPrincipal, id: string, callbackUrl: string, resume: { id: string } | undefined, params: Readonly<Record<string, string>>) {
    return this.oauth.store.withOwner(ownerOf(principal), async db => {
      const login = validLogin(await db.read(), id, this.now());
      if (resume?.id !== id || login.callbackUrl !== callbackUrl || !params.result || params.result !== login.result) return failed("invalid_approval_completion");
      if (login.status !== "approved" && login.status !== "filled") return failed("login_not_approved");
      return { token: `approved-${id}` };
    });
  }
  async fill(principal: ConnectionPrincipal, id: string, sessionId: string, fill: (credentials: { accessToken: string; integrationKey: string }, login: LoginRequest) => Promise<void>) {
    return this.oauth.store.withOwner(ownerOf(principal), async db => {
      const record = await db.read(), login = validLogin(record, id, this.now());
      if (login.sessionId !== sessionId) return failed("wrong_conversation");
      if (login.status === "filled") return { status: "destination_verified", url: login.successUrl };
      if (login.status !== "approved" || !login.reference) return failed("login_not_approved");
      const credentials = await this.oauth.activeCredentials(db, record);
      login.status = "failed";
      await db.write(record);
      await fill(credentials, login);
      login.status = "filled";
      login.reference = undefined;
      await db.write(record);
      return { status: "destination_verified", url: login.successUrl };
    });
  }
}
export const getOnePasswordLogin = () => new OnePasswordLogin(getOnePassword());
