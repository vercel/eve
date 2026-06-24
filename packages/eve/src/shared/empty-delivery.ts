export const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";

export function hasEmptyDeliverySentinel(text: string | null | undefined): boolean {
  return text?.includes(EMPTY_DELIVERY_SENTINEL) ?? false;
}
