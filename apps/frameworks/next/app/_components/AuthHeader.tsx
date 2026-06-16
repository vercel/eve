import { headers } from "next/headers";
import Image from "next/image";
import { getAuthJsSession } from "@/lib/auth";
import { SignInButton, SignOutButton } from "./AuthControls";

export async function AuthHeader() {
  const session = await getAuthJsSession({ headers: await headers() });
  const profile = session?.profile;
  const displayName = profile?.name ?? profile?.email ?? "Signed in";

  return (
    <header className="flex items-center justify-end gap-4 border-b border-neutral-200 px-6 py-3 text-sm dark:border-neutral-800">
      {profile ? (
        <>
          <span className="flex items-center gap-2 font-medium">
            {profile.image ? (
              <Image
                alt=""
                className="size-7 rounded-full border border-neutral-200 object-cover dark:border-neutral-800"
                height={28}
                src={profile.image}
                unoptimized
                width={28}
              />
            ) : null}
            <span>{displayName}</span>
          </span>
          <SignOutButton />
        </>
      ) : (
        <SignInButton />
      )}
    </header>
  );
}
