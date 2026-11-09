import type { Role } from "./session";

export interface Organization {
  id: string;
  name: string;
}

export interface User {
  id: string;
  orgId: string;
  role: Role;
  name: string;
  email: string;
}

export const organizations: readonly Organization[] = [
  { id: "org_brightside", name: "Brightside Studio" },
  { id: "org_harbor", name: "Harbor & Pine" },
];

/** Demo accounts for the login page. Production signs in through the identity provider. */
export const users: readonly User[] = [
  {
    id: "usr_maya",
    orgId: "org_brightside",
    role: "owner",
    name: "Maya Chen",
    email: "maya@brightside.studio",
  },
  {
    id: "usr_leo",
    orgId: "org_brightside",
    role: "member",
    name: "Leo Park",
    email: "leo@brightside.studio",
  },
  {
    id: "usr_sam",
    orgId: "org_harbor",
    role: "owner",
    name: "Sam Okafor",
    email: "sam@harborandpine.com",
  },
];

export function getOrganization(orgId: string): Organization | undefined {
  return organizations.find((organization) => organization.id === orgId);
}
