"use client";

import { useState } from "react";
import { EveLogoShader } from "./eve-logo-shader";
import { InstallSwitcher, type InstallAudience } from "./install-switcher";

export function HeroAudience({ tagline }: { tagline: string }) {
  const [audience, setAudience] = useState<InstallAudience>("humans");

  return (
    <>
      <div className="relative z-10 max-w-5xl text-center font-normal! text-heading-40 md:text-heading-48 lg:text-heading-56">
        <EveLogoShader audience={audience} />
        <h1 className="relative text-balance w-full max-w-[10em]">
          The framework for building agents
        </h1>
      </div>
      <p className="text-balance pt-[0.35em] relative z-10 w-full text-center text-copy-16 text-gray-900 md:max-w-2xl md:text-copy-18 lg:text-copy-20">
        {tagline}
      </p>
      <InstallSwitcher
        className="items-center mt-2 z-10"
        value={audience}
        onValueChange={setAudience}
      />
    </>
  );
}
