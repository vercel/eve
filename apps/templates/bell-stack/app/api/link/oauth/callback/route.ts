import { linkCallback } from "../../../../../server/link/callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => linkCallback(request);
