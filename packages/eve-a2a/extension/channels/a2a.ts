import { a2aChannel } from "../lib/a2a-channel";
import { httpBasic } from "eve/channels/auth";
import extension from "../extension";
import { requiredEnv } from "../lib/env";

export default a2aChannel(() => {
  const { server } = extension.config;
  return {
    origin: server.origin,
    secret: requiredEnv(server.signingSecretEnv),
    auth: server.users.map(({ username, passwordEnv }) =>
      httpBasic({ username, password: requiredEnv(passwordEnv) }),
    ),
  };
});
