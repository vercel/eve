import { createChatRoute } from "@vercel/geistdocs/routes/chat";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const maxDuration = 800;

const chatRoute = createChatRoute({
  config,
  sources: [geistdocsSource],
});

export const POST = chatRoute.POST;
