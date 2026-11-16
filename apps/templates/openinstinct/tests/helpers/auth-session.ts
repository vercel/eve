interface AuthSessionFixture {
  readonly session: {
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly id: string;
    readonly token: string;
    readonly updatedAt: Date;
    readonly userId: string;
  };
  readonly user: {
    readonly createdAt: Date;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: string;
    readonly name: string;
    readonly phoneNumber?: string | null;
    readonly phoneNumberVerified?: boolean | null;
    readonly updatedAt: Date;
  };
}

export function authSessionFor<
  const User extends Pick<AuthSessionFixture["user"], "id"> &
    Partial<AuthSessionFixture["user"]>,
>(user: User) {
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    session: {
      createdAt: now,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      id: `session-${user.id}`,
      token: `token-${user.id}`,
      updatedAt: now,
      userId: user.id,
    },
    user: {
      createdAt: now,
      email: `${user.id}@example.com`,
      emailVerified: true,
      name: user.id,
      updatedAt: now,
      ...user,
    },
  };
}
