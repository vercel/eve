import { vercelOidc, type AuthFn } from "eve/channels/auth";

const verify = vercelOidc();

// Only runtime principals bind the current project AND deployment environment.
export const runtimeAuth: AuthFn = async (request) => {
  const principal = await verify(request);
  return principal?.principalType === "runtime" ? principal : null;
};
