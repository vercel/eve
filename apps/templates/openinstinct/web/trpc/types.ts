import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "./router";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
