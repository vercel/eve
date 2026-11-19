import Image from "next/image";
import type { ReactNode } from "react";
import { requirePageScope } from "@/lib/auth/next";
import { env } from "@/lib/environment/env";
import { cn } from "@/lib/class-names";
import { SetupHelp } from "./_components/setup-help";

export const metadata = { title: "Deployment" };

const providers = {
  linq: { name: "Linq", className: "scale-90 dark:invert" },
  agentcard: { name: "Agentcard", className: "dark:invert" },
  kernel: { name: "Kernel", className: "scale-[.68] rounded-sm" },
  vercel: { name: "Vercel Blob", className: "-translate-y-0.5 scale-60 dark:invert" },
} as const;

export default async function Page() {
  await requirePageScope("/deployment");

  return (
    <div className="flex min-w-0 flex-col gap-6 py-8 sm:py-12">
      <h1 className="type-page-title">Deployment</h1>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:auto-rows-fr">
        <ServiceTile title="iMessage" provider="linq" configured={Boolean(env.LINQ_CONNECTOR)}>
          Attach a Linq line in <a href="https://vercel.com/connect/linq">Vercel Connect</a> with
          trigger path <code>/eve/v1/linq</code>. Set <code>LINQ_CONNECTOR</code> to the connector
          ID. If Linq requires users to text first, the sign-in page will prompt them to do so.
        </ServiceTile>
        <ServiceTile
          title="Agentcard"
          provider="agentcard"
          configured={Boolean(
            env.AGENTCARD_CLIENT_ID && env.AGENTCARD_CLIENT_SECRET && env.AGENTCARD_WEBHOOK_SECRET,
          )}
        >
          <span className="block">
            <strong>Checkout:</strong> Get credentials from{" "}
            <a href="https://opencommerce.sh">Agentcard</a> and set <code>AGENTCARD_CLIENT_ID</code>{" "}
            and <code>AGENTCARD_CLIENT_SECRET</code> in Vercel.
          </span>
          <span className="mt-2 block">
            <strong>Order updates:</strong> Register <code>/agentcard/webhooks</code> on your public
            deployment in Agentcard. Set <code>AGENTCARD_WEBHOOK_SECRET</code> to the signing
            secret. Webhooks cannot reach localhost.
          </span>
        </ServiceTile>
        <ServiceTile
          title="Browser fallback"
          provider="kernel"
          configured={Boolean(env.KERNEL_API_KEY)}
        >
          Attach Kernel through Vercel Marketplace or set <code>KERNEL_API_KEY</code> from your{" "}
          <a href="https://kernel.sh">Kernel account</a>. This key enables read-only public page
          research and static previews, not browser checkout.
        </ServiceTile>
        <ServiceTile
          title="Memory and images"
          provider="vercel"
          configured={Boolean(env.BLOB_STORE_ID || env.BLOB_READ_WRITE_TOKEN)}
        >
          Attach a{" "}
          <a href="https://vercel.com/docs/vercel-blob/private-storage">
            private Vercel Blob store
          </a>
          . For local image testing, set <code>BLOB_READ_WRITE_TOKEN</code> from a private store.
        </ServiceTile>
      </ul>
    </div>
  );
}

function ServiceTile({
  title,
  provider,
  configured,
  children,
}: {
  readonly title: string;
  readonly provider: keyof typeof providers;
  readonly configured: boolean;
  readonly children: ReactNode;
}) {
  const logo = providers[provider];

  return (
    <li className="flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground sm:gap-4 sm:p-4">
      <div className="relative size-10 shrink-0 sm:size-12">
        <Image
          src={`/deployment/${provider}.svg`}
          alt={title === logo.name ? "" : logo.name}
          fill
          className={cn("object-contain", logo.className)}
        />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="type-label">{title}</h2>
        <p className="type-caption mt-1 flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              configured ? "bg-success" : "bg-muted-foreground/50",
            )}
          />
          {configured ? "Configured" : "Not configured"}
        </p>
      </div>
      <SetupHelp title={title}>{children}</SetupHelp>
    </li>
  );
}
