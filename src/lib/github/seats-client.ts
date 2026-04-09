// GitHub Copilot Seat Management API Client

import { githubFetch, githubFetchPaginated } from "./api-base";
import type { CopilotSeat, CopilotSeatsResponse } from "@/lib/types/seats";

export class SeatsClient {
  async getOrgSeats(org: string): Promise<{ totalSeats: number; seats: CopilotSeat[] }> {
    // First call to get total_seats count
    const first = await githubFetch<CopilotSeatsResponse>(
      `/orgs/${org}/copilot/billing/seats?per_page=100`
    );

    if (!first) return { totalSeats: 0, seats: [] };

    const allSeats: CopilotSeat[] = [...(first.seats || [])];

    // Paginate if more seats exist (max 100 pages as safety limit)
    if (first.total_seats > 100) {
      let page = 2;
      const maxPages = 100;
      while (allSeats.length < first.total_seats && page <= maxPages) {
        const resp = await githubFetch<CopilotSeatsResponse>(
          `/orgs/${org}/copilot/billing/seats?per_page=100&page=${page}`
        );
        if (!resp?.seats?.length) break;
        allSeats.push(...resp.seats);
        page++;
      }
    }

    return { totalSeats: first.total_seats, seats: allSeats };
  }

  async getEnterpriseSeats(enterprise: string): Promise<{ totalSeats: number; seats: CopilotSeat[] }> {
    const first = await githubFetch<CopilotSeatsResponse>(
      `/enterprises/${enterprise}/copilot/billing/seats?per_page=100`
    );

    if (!first) return { totalSeats: 0, seats: [] };

    const allSeats: CopilotSeat[] = [...(first.seats || [])];

    if (first.total_seats > 100) {
      let page = 2;
      const maxPages = 100;
      while (allSeats.length < first.total_seats && page <= maxPages) {
        const resp = await githubFetch<CopilotSeatsResponse>(
          `/enterprises/${enterprise}/copilot/billing/seats?per_page=100&page=${page}`
        );
        if (!resp?.seats?.length) break;
        allSeats.push(...resp.seats);
        page++;
      }
    }

    return { totalSeats: first.total_seats, seats: allSeats };
  }
}

export const seatsClient = new SeatsClient();
