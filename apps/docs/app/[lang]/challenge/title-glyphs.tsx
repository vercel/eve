import { LogoEveSvg } from "@vercel/geistdocs/assets/logos/logo-eve-svg";
import Image from "next/image";
import { GlyphSeaView } from "./glyph-sea-view";
import poster from "./poster.module.css";
import { titleArtHeight, titleArtWidth } from "./title-art-data";
import { titleArtUrl } from "./title-art";
import { challengeTitle } from "./title-stencils";

export function TitleGlyphs() {
  return (
    <GlyphSeaView silhouette={<LogoEveSvg height={53} />}>
      <h1>
        <span className="sr-only">{challengeTitle}</span>
        <Image
          alt=""
          className={poster.art}
          fetchPriority="high"
          height={titleArtHeight}
          loading="eager"
          src={titleArtUrl}
          width={titleArtWidth}
          unoptimized
        />
      </h1>
    </GlyphSeaView>
  );
}
