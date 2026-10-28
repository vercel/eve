import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest();
export const same = (a, b) => timingSafeEqual(digest(a), digest(b));
export class DesktopAccess {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.tickets = new Map();
    this.sessions = new Map();
  }
  /** A ticket may name the one dashboard origin allowed to embed the live preview. */
  issue(origin = null) {
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, { expires: this.clock() + 300000, origin });
    return token;
  }
  exchange(token) {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.expires < this.clock()) return null;
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(session, this.clock() + 3600000);
    return { session, origin: ticket.origin };
  }
  session(cookie = "") {
    const token = cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("eve-desktop="))
      ?.slice(12);
    return !!token && (this.sessions.get(token) || 0) > this.clock();
  }
  prune() {
    for (const [k, v] of this.tickets) if (v.expires < this.clock()) this.tickets.delete(k);
    for (const [k, v] of this.sessions) if (v < this.clock()) this.sessions.delete(k);
  }
}

// The dashboard uses a one-use capability instead of third-party cookies.
// Local and deployed dashboards share one desktop, so each ticket carries its own origin.
export function authorizeDesktopSocket(access, { requestOrigin, desktopOrigin, ticket, cookie }) {
  if (ticket) {
    const granted = access.exchange(ticket);
    if (!granted || (requestOrigin !== desktopOrigin && requestOrigin !== granted.origin))
      return null;
    return `eve-desktop=${granted.session}`;
  }
  return requestOrigin === desktopOrigin && access.session(cookie) ? cookie : null;
}
