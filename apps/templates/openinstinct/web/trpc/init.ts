import { initTRPC } from "@trpc/server";
import type { TRPCContext } from "./context";

const t = initTRPC.context<TRPCContext>().create();

export const createTRPCRouter = t.router;
export const protectedProcedure = t.procedure;
