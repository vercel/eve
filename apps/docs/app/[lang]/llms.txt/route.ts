import { cacheLife } from "next/cache";
import { createLlmsIndex } from "@/lib/geistdocs/llms-index";
import { supportedLanguages } from "@/lib/geistdocs/languages";

const getLlmsIndex = async () => {
  "use cache";
  cacheLife("max");

  return createLlmsIndex();
};

export const GET = async () =>
  new Response(await getLlmsIndex(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));
