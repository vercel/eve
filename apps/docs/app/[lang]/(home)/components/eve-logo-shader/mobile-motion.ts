export const MOBILE_AUTO_ROTATE_SPEED = 0.15;

export type EvePointerInteractionMode = {
  paintEnabled: boolean;
  autoRotateEnvYaw: boolean;
};

export function evePointerInteractionMode(isCoarsePointer: boolean): EvePointerInteractionMode {
  return {
    paintEnabled: !isCoarsePointer,
    autoRotateEnvYaw: isCoarsePointer,
  };
}

export function mobileAutoEnvYaw(timeSeconds: number) {
  return timeSeconds * MOBILE_AUTO_ROTATE_SPEED;
}
