import { defineChannel, GET } from "eve/channels";

/**
 * The API behind the `probe` and `nested-probe` connections, served by the
 * fixture's own deployment so the suite stays self-contained. The bearer is
 * minted by each connection's `completeAuthorization` from the callback's
 * `?code=`, so the credential in the response proves the authorization
 * callback round-tripped: eval → hook → token → this route → tool result.
 */
const CREDENTIALS: ReadonlyArray<readonly [prefix: string, marker: string]> = [
  ["probe:", "PROBE-CREDENTIAL-"],
  ["nested-probe:", "NESTED-CREDENTIAL-"],
];

export default defineChannel({
  routes: [
    GET("/probe/credential", async (request) => {
      const header = request.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      for (const [prefix, marker] of CREDENTIALS) {
        if (token.startsWith(prefix)) {
          return Response.json({ credential: `${marker}${token.slice(prefix.length)}` });
        }
      }
      return Response.json({ error: "Missing or unknown probe token." }, { status: 401 });
    }),
  ],
});
