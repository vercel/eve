import { authMiddleware } from "@/lib/auth";

export const GET = authMiddleware;
export const POST = authMiddleware;
