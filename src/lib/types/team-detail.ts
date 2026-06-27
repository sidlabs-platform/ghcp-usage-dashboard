export interface TeamInfo {
  slug: string;
  name: string;
  org: string | null;
  memberCount: number;
}

export interface MemberRow {
  login: string;
  activeDays: number;
  locAdded: number;
  interactions: number;
  acceptanceRate: number;
  usedAgent: number;
  usedChat: number;
  usedCli: number;
  usedCodeReview: number;
}

export interface Aggregates {
  totalLocAdded: number;
  avgAcceptanceRate: number;
  agentAdoption: number;
  chatAdoption: number;
  cliAdoption: number;
  activeMembers: number;
}

export interface TeamDetailResponse {
  team: TeamInfo | null;
  members: MemberRow[];
  aggregates: Aggregates | null;
}
