import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Custom HTTP routes preserve URL boundaries, HEAD dispatch, and CORS through the deployed host.",
  async test(t) {
    for (const [encoded, expected] of [
      ["caf%C3%A9", "café"],
      ["a%20b", "a b"],
      ["a%2Fb", "a%2Fb"],
      ["a%5Cb", "a%5Cb"],
      ["a%252Fb", "a%252Fb"],
    ]) {
      const response = await t.target.fetch(`/http-compat/params/${encoded}`);
      await t.require(response.status, equals(200));
      const params = (await response.json()) as { value: string };
      await t.require(params.value, equals(expected));
    }
    const canonical = await t.target.fetch("/http-compat/st%61tic");
    await t.require(await canonical.text(), equals("canonical"));
    for (const malformed of ["%ZZ", "%C0%AF"]) {
      const response = await t.target.fetch(`/http-compat/params/${malformed}`);
      await t.require(response.status, equals(400));
    }
    for (const [path, handler] of [
      ["head", "GET"],
      ["explicit", "HEAD"],
    ]) {
      const response = await t.target.fetch(`/http-compat/${path}`, { method: "HEAD" });
      await t.require(response.status, equals(200));
      await t.require(response.headers.get("x-handler"), equals(handler));
      await t.require(await response.text(), equals(""));
      if (handler === "GET")
        await t.require(response.headers.get("x-channel-method"), equals("HEAD"));
    }
    const preflight = await t.target.fetch("/http-compat/head", {
      method: "OPTIONS",
      headers: { origin: "https://channel.example", "access-control-request-method": "GET" },
    });
    await t.require(preflight.status, equals(204));
    await t.require(
      preflight.headers.get("access-control-allow-origin"),
      equals("https://channel.example"),
    );
    const failure = await t.target.fetch("/http-compat/error", {
      headers: { origin: "https://channel.example" },
    });
    await t.require(failure.status, equals(500));
    await t.require(
      failure.headers.get("access-control-allow-origin"),
      equals("https://channel.example"),
    );
    await t.require(
      await failure.text(),
      satisfies(
        (body: string) => !body.includes("fixture-private-error"),
        "channel errors omit private details",
      ),
    );
  },
});
