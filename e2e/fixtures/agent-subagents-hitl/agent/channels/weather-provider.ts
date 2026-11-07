import { defineChannel, GET } from "eve/channels";

import { storeGrant } from "../lib/weather-grants";
import { ACCEPT_CODE, GRANT_TOKEN } from "../lib/weather-sign-in";

/**
 * The fixture weather provider's consent page. As Vercel Connect does, it stores the person's
 * grant when they accept, before it sends them on to eve's callback, so every session waiting on
 * the sign-in can read the grant once the callback arrives. It answers with the callback URL to
 * open instead of a redirect, so the eval opens it with its own credentials.
 */
export default defineChannel({
  routes: [
    GET("/fixture-weather/authorize", async (request) => {
      const url = new URL(request.url);
      const callback = url.searchParams.get("callback");
      if (callback === null)
        return new Response("A consent link names its callback.", { status: 400 });
      const grant = url.searchParams.get("grant");
      const code = url.searchParams.get("code");
      if (code === ACCEPT_CODE && grant !== null) await storeGrant(grant, GRANT_TOKEN);
      const next = new URL(callback);
      for (const name of ["code", "error"]) {
        const value = url.searchParams.get(name);
        if (value !== null) next.searchParams.set(name, value);
      }
      return Response.json({ callback: next.toString() });
    }),
  ],
});
