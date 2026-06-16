import { Button } from "@vercel/geistdocs/components/button";
import Link from "next/link";

export function CTA() {
  return (
    <section className="flex flex-col items-center justify-between gap-4 px-8 py-10 md:flex-row sm:px-12">
      <h2 className="text-xl font-semibold tracking-tighter text-gray-1000 sm:text-2xl md:text-3xl lg:text-[40px]">
        Build your first agent today.
      </h2>
      <Button asChild size="lg" className="w-fit text-base h-12">
        <Link href="/docs/getting-started">Get started</Link>
      </Button>
    </section>
  );
}
