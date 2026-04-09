// Types for the GitHub Teams API (org teams + enterprise teams)

export interface GitHubTeam {
  id: number;
  node_id: string;
  name: string;
  slug: string;
  description: string | null;
  privacy: string;
  permission: string;
  url: string;
  html_url: string;
  members_url: string;
  repositories_url: string;
  parent: GitHubTeam | null;
}

export interface GitHubTeamMember {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  url: string;
  html_url: string;
  type: string;
  site_admin: boolean;
}

export interface EnterpriseTeam {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  members_count?: number;
}

export interface EnterpriseTeamMembership {
  login: string;
  id: number;
  avatar_url: string;
  role?: string;
}

// Internal representation used by the dashboard
export interface TeamWithMembers {
  slug: string;
  name: string;
  description: string | null;
  source: "org" | "enterprise";
  orgSlug?: string;
  members: string[]; // array of user logins
}
