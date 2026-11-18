import { PersonalInfoForm } from "./_components/personal-info-form";
import { readUserProfile } from "@db/services/user-profile";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function Page() {
  const scope = await requireRequestScope();
  return <PersonalInfoForm initialProfile={await readUserProfile(scope)} />;
}
