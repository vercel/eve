import { toCard, toPartialCard } from "@json-render/chat";
import type { Spec } from "@json-render/core";
import type { CardElement } from "eve/cards";
import { defineContentRenderer } from "eve/renderers";

import { CARD_LIMITS, CARD_MEDIA_TYPE, cardComponents } from "../lib/spec";

export default defineContentRenderer({
  mediaType: CARD_MEDIA_TYPE,
  card(value, { partial }) {
    const card = partial
      ? toPartialCard(value as Partial<Spec>, { components: cardComponents })
      : toCard(value as Spec, { components: cardComponents, limits: CARD_LIMITS });
    // json-render types cards with Chat SDK's declarations; eve declares its own copy.
    return card as CardElement | null;
  },
});
