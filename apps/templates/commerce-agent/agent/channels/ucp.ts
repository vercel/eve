import { defineChannel, GET } from "eve/channels";
import { agentProfile } from "@/lib/ucp";

/**
 * Serves this agent's UCP profile.
 *
 * UCP has no registration step: a merchant learns who is calling by
 * fetching the URL in the `UCP-Agent` header, and finds the public key to
 * verify signatures in this document's `signing_keys`. If this endpoint is
 * unreachable, merchants answer with `profile_unreachable` (HTTP 424).
 *
 * The spec requires HTTPS, forbids 3xx responses, and requires a
 * `Cache-Control` of `public` with `max-age` of at least 60 seconds.
 */
export default defineChannel({
  cors: true,
  routes: [
    GET("/.well-known/ucp", async () => {
      return new Response(JSON.stringify(agentProfile()), {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "application/json",
        },
      });
    }),
  ],
});
