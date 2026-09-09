export function activeTurnToken(sessionId: string): string {
  return `eve:turn:${sessionId}`;
}
