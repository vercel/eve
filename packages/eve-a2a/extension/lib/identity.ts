import { createHmac, timingSafeEqual } from "node:crypto";
import { RpcError } from "./protocol";

// The signed task ID carries its session binding, so restart needs no process-local registry.
export function taskIdentity(secret: string) {
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
        throw new RpcError(-32001, "Task not found");
      }
    },
  };
}
