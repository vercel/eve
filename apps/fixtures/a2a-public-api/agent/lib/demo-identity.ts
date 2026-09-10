import { createHmac, timingSafeEqual } from "node:crypto";

// Keep the test session handle scoped to its authenticated owner across server restarts.
export function demoIdentity(secret: string) {
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest();
  return {
    issue(sessionId: string, owner: string): string {
      const payload = Buffer.from(JSON.stringify({ sessionId, owner })).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    read(id: string, owner: string): string {
      try {
        const [payload, signature, extra] = id.split(".");
        if (!payload || !signature || extra) throw new Error();
        const supplied = Buffer.from(signature, "base64url");
        const expected = sign(payload);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          throw new Error();
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (claims.owner !== owner || typeof claims.sessionId !== "string") throw new Error();
        return claims.sessionId;
      } catch {
        throw new Error("Demo session not found");
      }
    },
  };
}
