import { LogoIconVercel } from "@vercel/geistdocs/assets/logos/logo-icon-vercel";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { NightsGalaxy } from "./nights-galaxy";

const title = "eve eves";
const description = "eve eves bring the community together after dark.";
const ogImage = {
  url: "/eve-nights-og.png",
  width: 3200,
  height: 1800,
  alt: "eve community nights",
};

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#000000",
};

const events = [
  {
    city: "san francisco",
    date: "thursday, august 27, 17:30 pdt",
    href: "https://luma.com/eveSF",
  },
  {
    city: "new york",
    date: "tuesday, september 8, 17:30 edt",
    href: "https://luma.com/eveNY",
  },
  {
    city: "london",
    date: "tuesday, september 15, 17:30 bst",
    href: "https://luma.com/eveLDN",
  },
] as const;

const LogoPlaceholder = ({ target = false }: { target?: boolean }) => (
  <div
    data-galaxy-logo-target={target ? "" : undefined}
    aria-hidden="true"
    className="aspect-[169/53] w-[calc(100vw-64px)] max-w-[540px] min-[740px]:w-full"
  />
);

const NightsPage = () => (
  <div data-nights-route className="relative h-lvh overflow-hidden bg-black text-white">
    <div className="pointer-events-none fixed inset-0" aria-hidden="true">
      <NightsGalaxy />
      <div className="mx-auto grid h-full w-full max-w-6xl grid-cols-1 grid-rows-[40svh_1fr] min-[740px]:grid-cols-2 min-[740px]:grid-rows-1">
        <div className="flex h-full items-center justify-center p-4">
          <LogoPlaceholder target />
        </div>
      </div>
    </div>

    <div className="relative mx-auto grid h-lvh w-full max-w-6xl grid-cols-1 grid-rows-[40svh_1fr] min-[740px]:grid-cols-2 min-[740px]:grid-rows-1">
      <div className="flex min-h-0 items-center justify-center p-4" aria-hidden="true">
        <LogoPlaceholder />
      </div>
      <main className="flex min-h-0 items-center p-4">
        <div className="mx-auto flex w-full max-w-md flex-col justify-center gap-12">
          <h1 className="sr-only">eve eves</h1>
          <div
            data-nights-animated
            className="grid w-full grid-cols-3 items-center animate-[eve-nights-rise_700ms_ease-out_both]"
          >
            <span className="justify-self-start font-mono text-[14px] text-white/40">eve eves</span>
            <Link
              aria-label="back to eve.dev"
              className="justify-self-center text-white transition-opacity hover:opacity-70"
              href="/"
            >
              <LogoIconVercel size={18} />
            </Link>
            <span className="justify-self-end font-mono text-[14px] text-white/40">2026</span>
          </div>

          <div className="-mx-3 flex w-[calc(100%+24px)] flex-col gap-2">
            {events.map((event) => (
              <a
                key={event.city}
                data-nights-animated
                className="group flex w-full touch-manipulation items-end justify-between rounded px-3 py-3 transition-colors hover:bg-white/5 focus-visible:bg-white/10 focus-visible:outline-none animate-[eve-nights-rise_700ms_120ms_ease-out_both]"
                href={event.href}
                rel="noreferrer"
                target="_blank"
              >
                <span className="flex min-w-0 flex-col gap-0.5 pr-4">
                  <span className="font-mono text-[14px] font-medium text-white">{event.city}</span>
                  <span className="font-mono text-[11px] text-white/50 min-[440px]:text-[13px]">
                    {event.date}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[14px] text-white/50 transition-colors group-hover:text-white group-focus-visible:text-white group-focus-visible:underline group-focus-visible:underline-offset-4">
                  RSVP<span aria-hidden="true">›</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </main>
    </div>
  </div>
);

export default NightsPage;
