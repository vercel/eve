import { Feed } from "feed";
import { cacheLife } from "next/cache";
import type { NextRequest } from "next/server";
import { title } from "@/geistdocs";
import { supportedLanguages } from "@/lib/geistdocs/languages";
import { getFeedUpdatedAt, selectDatedFeedPages } from "@/lib/geistdocs/rss";
import { source } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";

const baseUrl = getSiteOrigin();

const getFeed = async (lang: string) => {
  "use cache";
  cacheLife("max");

  const pages = selectDatedFeedPages(source.getPages(lang));
  const feed = new Feed({
    title,
    id: baseUrl,
    link: baseUrl,
    language: lang,
    updated: getFeedUpdatedAt(pages),
    copyright: `All rights reserved ${new Date().getFullYear()}, Vercel`,
  });

  for (const { lastModified, page } of pages) {
    feed.addItem({
      id: page.url,
      title: page.data.title ?? page.url,
      description: page.data.description,
      link: `${baseUrl}${page.url}`,
      date: lastModified,
      author: [
        {
          name: "Vercel",
        },
      ],
    });
  }

  return feed.rss2();
};

export const GET = async (_req: NextRequest, { params }: RouteContext<"/[lang]/rss.xml">) => {
  const { lang } = await params;
  const rss = await getFeed(lang);

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml",
    },
  });
};

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));
