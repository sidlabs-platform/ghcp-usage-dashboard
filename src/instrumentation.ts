// Next.js instrumentation hook — runs once on server startup.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Only run on the Node.js server runtime (not edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoSync } = await import("@/lib/sync/auto-sync-scheduler");
    startAutoSync();
  }
}
