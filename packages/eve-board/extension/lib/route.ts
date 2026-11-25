export const DEFAULT_BOARD_ROUTE_BASE = "/eve/v1/board";
export const BOARD_WAKE_ROUTE = `${DEFAULT_BOARD_ROUTE_BASE}/wake`;
export const LEGACY_BOARD_WAKE_ROUTE = "/board/wake";

const INVALID_ROUTE_CHARS = /[\s?#:*[\]]/u;

export function isValidBoardRouteBase(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return false;
  if (INVALID_ROUTE_CHARS.test(trimmed)) return false;
  if (trimmed.includes("//")) return false;
  return trimmed.replace(/\/+$/u, "").length > 0;
}

export function normalizeBoardRouteBase(route: string | undefined): string {
  if (route === undefined) return DEFAULT_BOARD_ROUTE_BASE;
  if (!isValidBoardRouteBase(route)) {
    throw new Error(
      `Board route ${JSON.stringify(route)} is invalid: use an absolute path without parameters or query string, such as "${DEFAULT_BOARD_ROUTE_BASE}".`,
    );
  }
  return route.trim().replace(/\/+$/u, "");
}
