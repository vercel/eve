import { approvalPage, approvalPost } from "../../../../server/onepassword/approval-http";
import { onePasswordGet, onePasswordPost } from "../../../../server/onepassword/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) { const { action } = await context.params; return action === "approval" ? approvalPage() : onePasswordGet(request, action); }
export async function POST(request: Request, context: Context) { const { action } = await context.params; return action === "approval-open" || action === "approval-poll" ? approvalPost(request, action) : onePasswordPost(request, action); }
