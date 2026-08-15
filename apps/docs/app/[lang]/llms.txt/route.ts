import { createLlmsIndex } from "@/lib/geistdocs/llms-index";

export const revalidate = false;

export const GET = () =>
  new Response(createLlmsIndex(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
