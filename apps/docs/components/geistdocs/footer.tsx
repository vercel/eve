import { SiGithub, SiVercel } from "@icons-pack/react-simple-icons";
import { Button } from "@vercel/geistdocs/components/button";
import { LanguageSelector, ThemeToggle } from "@vercel/geistdocs/controls";
import type { GeistdocsConfig } from "@vercel/geistdocs/config";
import { RssIcon } from "lucide-react";
import Link from "next/link";

interface FooterProps {
  config: Pick<GeistdocsConfig, "github">;
  copyright?: string;
}

export const Footer = ({
  config,
  copyright = `Copyright Vercel ${new Date().getFullYear()}. All rights reserved.`,
}: FooterProps) => {
  const githubUrl =
    config.github?.owner && config.github.repo
      ? `https://github.com/${config.github.owner}/${config.github.repo}`
      : undefined;

  return (
    <footer className="border-t px-4 py-5 md:px-6">
      <div className="mx-auto flex max-w-[1448px] flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-gray-800 text-sm sm:justify-start">
          <span className="flex items-center gap-2">
            <SiVercel className="size-4 shrink-0" />
            <span className="text-center sm:text-left">{copyright}</span>
          </span>
          <Link
            className="font-medium text-gray-900 underline-offset-4 transition-colors hover:text-gray-1000 hover:underline"
            href="/docs/responsible-use"
          >
            Responsible Use
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSelector />
          <Button asChild size="icon-sm" type="button" variant="ghost">
            <a href="/rss.xml" rel="noopener" target="_blank">
              <RssIcon className="size-4" />
            </a>
          </Button>
          {githubUrl ? (
            <Button asChild size="icon-sm" type="button" variant="ghost">
              <a href={githubUrl} rel="noopener" target="_blank">
                <SiGithub className="size-4" />
              </a>
            </Button>
          ) : null}
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
};
