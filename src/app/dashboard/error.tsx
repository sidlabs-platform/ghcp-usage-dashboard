"use client";

import { useEffect } from "react";

/**
 * Next.js App Router error boundary for the dashboard route group.
 * Catches rendering errors in any dashboard page and displays a
 * recoverable error UI instead of a white screen.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Dashboard Error Boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border bg-[hsl(var(--card))] p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6 text-red-600 dark:text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>

        <h2 className="mb-2 text-lg font-semibold text-[hsl(var(--foreground))]">
          Something went wrong
        </h2>
        <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">
          An error occurred while rendering this dashboard page.
        </p>

        {process.env.NODE_ENV === "development" && (
          <pre className="mb-4 max-h-32 overflow-auto rounded-md bg-[hsl(var(--muted))] p-3 text-left text-xs text-[hsl(var(--foreground))]">
            {error.message}
            {error.stack && `\n\n${error.stack}`}
          </pre>
        )}

        <button
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Try Again
        </button>
      </div>
    </div>
  );
}
