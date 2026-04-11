// Shared GitHub API fetch utilities with auth, retry, and pagination

const GITHUB_API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";
const API_VERSION = "2026-03-10";

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable is required");
  return token;
}

function headers(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${getToken()}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function githubFetch<T>(path: string, retries = 3): Promise<T> {
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, { headers: headers(), cache: "no-store" });

    if (resp.ok) {
      return resp.json() as Promise<T>;
    }

    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = resp.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
      console.warn(`GitHub API ${resp.status} on ${path}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(waitMs);
      continue;
    }

    if (resp.status === 204) {
      return null as T;
    }

    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub API error ${resp.status} on ${path}: ${body}`);
  }

  throw new Error(`GitHub API failed after ${retries} retries on ${path}`);
}

export async function githubFetchPaginated<T>(path: string, perPage = 100): Promise<T[]> {
  const all: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}per_page=${perPage}&page=${page}`;
    const resp = await fetch(
      url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`,
      { headers: headers(), cache: "no-store" }
    );

    if (!resp.ok) {
      if (resp.status === 204) break;
      throw new Error(`GitHub API error ${resp.status} on ${url}`);
    }

    const data = await resp.json();
    const items = Array.isArray(data) ? data : data.seats || data.members || [];
    if (items.length === 0) break;

    all.push(...items);
    if (items.length < perPage) break;
    page++;
  }

  return all;
}

export async function fetchNDJSON<T>(downloadUrl: string): Promise<T[]> {
  const resp = await fetch(downloadUrl, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Failed to download NDJSON: ${resp.status}`);
  }

  const text = await resp.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export async function githubFetchPaginatedWithCutoff<
  T extends { updated_at: string },
>(
  path: string,
  cutoffDate: string | null = null,
  perPage = 100,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  const MAX_PAGES = 500;

  while (page <= MAX_PAGES) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}per_page=${perPage}&page=${page}`;
    const fullUrl = url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`;
    const resp = await fetch(fullUrl, { headers: headers(), cache: "no-store" });

    if (!resp.ok) {
      if (resp.status === 204) break;
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const waitMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.pow(2, page % 3) * 1000;
        console.warn(`GitHub API ${resp.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const body = await resp.text().catch(() => "");
      throw new Error(`GitHub API error ${resp.status}: ${body}`);
    }

    const batch: T[] = await resp.json();
    if (!batch || batch.length === 0) break;

    if (cutoffDate) {
      let foundCutoff = false;
      for (const item of batch) {
        if (item.updated_at >= cutoffDate) {
          all.push(item);
        } else {
          foundCutoff = true;
        }
      }
      if (foundCutoff) return all;
    } else {
      all.push(...batch);
    }

    if (batch.length < perPage) break;
    page++;
    if (page > 1) await sleep(200);
  }

  return all;
}

export async function githubFetchCursorPaginatedWithCutoff<
  T extends { updated_at: string },
>(
  path: string,
  cutoffDate: string | null = null,
  perPage = 100,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | null = null;
  const MAX_ITERATIONS = 500;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const separator: string = path.includes("?") ? "&" : "?";
    const cursorParam: string = after ? `&after=${after}` : "";
    const url: string = `${path}${separator}per_page=${perPage}${cursorParam}`;
    const fullUrl: string = url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`;
    const resp: Response = await fetch(fullUrl, { headers: headers(), cache: "no-store" });

    if (!resp.ok) {
      if (resp.status === 204) break;
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const waitMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.pow(2, i % 3) * 1000;
        console.warn(`GitHub API ${resp.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const body = await resp.text().catch(() => "");
      throw new Error(`GitHub API error ${resp.status}: ${body}`);
    }

    const batch: T[] = await resp.json();
    if (!batch || batch.length === 0) break;

    if (cutoffDate) {
      let foundCutoff = false;
      for (const item of batch) {
        if (item.updated_at >= cutoffDate) {
          all.push(item);
        } else {
          foundCutoff = true;
        }
      }
      if (foundCutoff) return all;
    } else {
      all.push(...batch);
    }

    // Extract cursor from Link header: <...&after=CURSOR>; rel="next"
    const linkHeader: string = resp.headers.get("link") || "";
    const nextMatch: RegExpMatchArray | null = linkHeader.match(/<[^>]*[?&]after=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      after = nextMatch[1];
    } else {
      break;
    }

    await sleep(200);
  }

  return all;
}

export { GITHUB_API_BASE, sleep };
