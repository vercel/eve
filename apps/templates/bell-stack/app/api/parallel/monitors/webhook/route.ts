import { receiveWebhook } from "../../../../../server/monitors/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export function POST(request: Request) { return receiveWebhook(request); }
