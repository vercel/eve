import { httpBasic } from "eve/channels/auth";

export const demoAuth = [
  httpBasic({ username: "alice", password: process.env.A2A_DEMO_PASSWORD ?? "prototype-only" }),
  httpBasic({
    username: "bob",
    password: process.env.A2A_OTHER_PASSWORD ?? "other-prototype-only",
  }),
];
