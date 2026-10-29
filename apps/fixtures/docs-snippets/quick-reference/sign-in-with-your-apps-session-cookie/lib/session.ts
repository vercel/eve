export interface AppSession {
  userId: string;
  orgId: string;
  role: "owner" | "member";
}

export async function getSession(_cookieHeader: string | null): Promise<AppSession | null> {
  return null;
}
