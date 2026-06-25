import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/database';

function buildEnterpriseFilter(slugs?: string[], alias?: string): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: '', params: [] };
  const placeholders = slugs.map(() => '?').join(',');
  const prefix = alias ? `${alias}.` : '';
  return { clause: ` AND ${prefix}enterprise_slug IN (${placeholders})`, params: slugs };
}

function parseScopeFilterFromParams(searchParams: URLSearchParams) {
  const t = searchParams.get('teams');
  const o = searchParams.get('orgs');
  const e = searchParams.get('enterprises');
  return {
    teams: t ? t.split(',') : [],
    orgs: o ? o.split(',') : [],
    enterprises: e ? e.split(',') : []
  };
}

function filterByScopeLocal(rows: any[], teams: string[], orgs: string[]) {
  if (teams.length === 0 && orgs.length === 0) return rows;
  
  return rows.filter((row: any) => {
    let orgMatch = true;
    let teamMatch = true;
    
    if (orgs.length > 0) {
        orgMatch = orgs.includes(row.org_slug);
    }
    
    if (teams.length > 0 && row.teams) {
        let rowTeams: string[] = [];
        try {
            rowTeams = typeof row.teams === 'string' ? JSON.parse(row.teams) : row.teams;
        } catch(e) {}
        teamMatch = rowTeams.some((t: string) => teams.includes(t));
    } else if (teams.length > 0) {
        teamMatch = false; // No teams on row but teams filter provided
    }
    
    return orgMatch && teamMatch;
  });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const startDay = searchParams.get('startDay');
    const endDay = searchParams.get('endDay');

    if (!startDay || !endDay) {
      return NextResponse.json({ error: 'startDay and endDay are required' }, { status: 400 });
    }

    const scopeFilter = parseScopeFilterFromParams(searchParams);
    const teams = scopeFilter.teams;
    const orgs = scopeFilter.orgs;
    const enterprises = scopeFilter.enterprises;

    const db = getDb();
    const ef = buildEnterpriseFilter(enterprises);
    const rows = db.prepare(`
      SELECT *
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ?${ef.clause}
      ORDER BY assignee_login ASC, day ASC
    `).all(startDay, endDay, ...ef.params) as any[];

    const filteredData = filterByScopeLocal(rows, teams, orgs);

    if (filteredData.length === 0) {
        return new NextResponse('', {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="copilot-users-export-${startDay}-to-${endDay}.csv"`,
            }
        });
    }

    // Extract headers from the first row
    const headers = Object.keys(filteredData[0]).join(',');
    
    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Enqueue the header row
        controller.enqueue(encoder.encode(headers + '\n'));

        // Process and enqueue rows in batches
        const BATCH_SIZE = 500;
        let index = 0;

        function pushBatch() {
          let batchEnd = Math.min(index + BATCH_SIZE, filteredData.length);
          let chunk = '';
          for (let i = index; i < batchEnd; i++) {
              const row = filteredData[i];
              const values = Object.values(row).map(val => {
                  if (val === null || val === undefined) return '';
                  // Handle JSON or string fields that might contain commas
                  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                      return `"${str.replace(/"/g, '""')}"`;
                  }
                  return str;
              });
              chunk += values.join(',') + '\n';
          }
          controller.enqueue(encoder.encode(chunk));
          index = batchEnd;

          if (index < filteredData.length) {
              // Yield to event loop to avoid blocking
              setTimeout(pushBatch, 0);
          } else {
              controller.close();
          }
        }
        
        pushBatch();
      }
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="copilot-users-export-${startDay}-to-${endDay}.csv"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });

  } catch (err: any) {
    console.error('CSV Export Error:', err);
    return NextResponse.json({ error: 'Failed to generate CSV export' }, { status: 500 });
  }
}
