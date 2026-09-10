import a2a from "@eve/a2a";

// Fixed credentials belong only to this loopback demonstration fixture.
process.env.A2A_DEMO_PASSWORD ??= "prototype-only";
process.env.A2A_OTHER_PASSWORD ??= "other-prototype-only";
process.env.A2A_SIGNING_SECRET ??= "local-prototype-signing-key-do-not-deploy";

export default a2a({
  server: {
    origin: process.env.A2A_ORIGIN ?? "http://localhost:4317",
    signingSecretEnv: "A2A_SIGNING_SECRET",
    users: [
      { username: "alice", passwordEnv: "A2A_DEMO_PASSWORD" },
      { username: "bob", passwordEnv: "A2A_OTHER_PASSWORD" },
    ],
  },
  remote: {
    origin: process.env.A2A_REMOTE_ORIGIN ?? "http://localhost:4317",
    username: "alice",
    passwordEnv: "A2A_DEMO_PASSWORD",
  },
});
