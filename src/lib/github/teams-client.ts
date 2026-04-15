// GitHub Teams API Client (org teams + enterprise teams)

import { githubFetch, githubFetchPaginated } from "./api-base";
import type {
  GitHubTeam,
  GitHubTeamMember,
  EnterpriseTeam,
  EnterpriseTeamMembership,
  TeamWithMembers,
} from "@/lib/types/teams";

export class TeamsClient {
  // ── Organization teams ─────────────────────────────────────────────

  async getOrgTeams(org: string, enterpriseSlug?: string): Promise<GitHubTeam[]> {
    return githubFetchPaginated<GitHubTeam>(`/orgs/${org}/teams`, 100, undefined, enterpriseSlug);
  }

  async getOrgTeamMembers(org: string, teamSlug: string, enterpriseSlug?: string): Promise<GitHubTeamMember[]> {
    return githubFetchPaginated<GitHubTeamMember>(`/orgs/${org}/teams/${teamSlug}/members`, 100, undefined, enterpriseSlug);
  }

  async getOrgTeamsWithMembers(org: string, enterpriseSlug?: string): Promise<TeamWithMembers[]> {
    const teams = await this.getOrgTeams(org, enterpriseSlug);
    const results: TeamWithMembers[] = [];

    for (const team of teams) {
      try {
        const members = await this.getOrgTeamMembers(org, team.slug, enterpriseSlug);
        results.push({
          slug: team.slug,
          name: team.name,
          description: team.description,
          source: "org",
          orgSlug: org,
          members: members.map((m) => m.login),
        });
      } catch (err) {
        console.error(`Failed to fetch members for org team ${org}/${team.slug}:`, err);
      }
    }

    return results;
  }

  // ── Enterprise teams (public preview) ──────────────────────────────

  async getEnterpriseTeams(enterprise: string, enterpriseSlug?: string): Promise<EnterpriseTeam[]> {
    try {
      return await githubFetchPaginated<EnterpriseTeam>(`/enterprises/${enterprise}/teams`, 100, undefined, enterpriseSlug);
    } catch (err) {
      console.warn("Enterprise Teams API not available (may require public preview access):", err);
      return [];
    }
  }

  async getEnterpriseTeamMembers(
    enterprise: string,
    teamSlug: string,
    enterpriseSlug?: string
  ): Promise<EnterpriseTeamMembership[]> {
    try {
      return await githubFetchPaginated<EnterpriseTeamMembership>(
        `/enterprises/${enterprise}/teams/${teamSlug}/memberships`, 100, undefined, enterpriseSlug
      );
    } catch (err) {
      console.warn(`Failed to fetch enterprise team members for ${teamSlug}:`, err);
      return [];
    }
  }

  async getEnterpriseTeamsWithMembers(enterprise: string, enterpriseSlug?: string): Promise<TeamWithMembers[]> {
    const teams = await this.getEnterpriseTeams(enterprise, enterpriseSlug);
    const results: TeamWithMembers[] = [];

    for (const team of teams) {
      const members = await this.getEnterpriseTeamMembers(enterprise, team.slug, enterpriseSlug);
      results.push({
        slug: team.slug,
        name: team.name,
        description: null,
        source: "enterprise",
        members: members.map((m) => m.login),
      });
    }

    return results;
  }
}

export const teamsClient = new TeamsClient();
