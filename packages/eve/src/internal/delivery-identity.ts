const DELIVERY_ID = Symbol.for("eve.delivery-id");

export function withDeliveryId<T extends object>(value: T, id: string): T {
  return Object.assign(value, { [DELIVERY_ID]: id });
}

export function readDeliveryId(value: object): string | undefined {
  return (value as { [DELIVERY_ID]?: string })[DELIVERY_ID];
}
