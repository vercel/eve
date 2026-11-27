import { IconArrowUpRightSmall } from "@vercel/geistdocs/assets/icons";

const announcementUrl = "https://vercel.com/blog/eve-is-now-generally-available";

export const AnnouncementBanner = () => (
  <a
    className="group flex min-h-10 items-center justify-center gap-1.5 bg-gray-1000 px-4 py-2 text-center text-background-100 text-copy-13 transition-colors hover:bg-gray-900 focus-visible:shadow-[var(--ds-focus-ring)] focus-visible:outline-none motion-reduce:transition-none"
    href={announcementUrl}
    rel="noopener"
    target="_blank"
  >
    <span>
      <span className="font-medium">eve 1.0 is now generally available.</span>{" "}
      <span className="underline-offset-4 group-hover:underline">Read the announcement</span>
    </span>
    <IconArrowUpRightSmall aria-hidden className="shrink-0" size={16} />
  </a>
);
