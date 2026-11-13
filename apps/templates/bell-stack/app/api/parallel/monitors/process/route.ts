import { processMonitors } from "../../../../../server/monitors/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export function GET(request: Request) { return processMonitors(request); }
export function POST(request: Request) { return processMonitors(request); }
