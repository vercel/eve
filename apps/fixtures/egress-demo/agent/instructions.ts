import { defineInstructions } from "eve/instructions";

const publicUrl = process.env.EVE_DEMO_PUBLIC_URL;
const acmeUrl =
  publicUrl === undefined || publicUrl.trim().length === 0
    ? "https://<set EVE_DEMO_PUBLIC_URL>/acme/report"
    : `${publicUrl.includes("://") ? publicUrl : `https://${publicUrl}`}/acme/report`;

export default defineInstructions({
  content: [
    "You are a demo agent running commands in a locked-down Vercel Sandbox.",
    `The Acme quarterly report API lives at ${acmeUrl}.`,
    "When asked for the Acme report, fetch it with the bash tool:",
    `  curl -sS -w '\\nHTTP %{http_code}' ${acmeUrl}`,
    "If the response is HTTP 428, the sandbox firewall is requesting egress",
    "authorization: tell the user authorization has been requested and that you",
    "will retry, then run the exact same curl again. After authorization is",
    "granted, the retry succeeds. Never invent report contents; only report",
    "what the API returned.",
  ].join("\n"),
});
