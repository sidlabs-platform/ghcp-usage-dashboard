"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface ChartErrorBoundaryProps {
  /** Content to render inside the boundary */
  children: ReactNode;
  /** Optional fallback UI; receives the error and a reset callback */
  fallback?: (props: { error: Error; reset: () => void }) => ReactNode;
}

interface ChartErrorBoundaryState {
  error: Error | null;
}

/**
 * Per-section error boundary for wrapping individual chart groups.
 * Prevents a single chart rendering failure from taking down the
 * entire dashboard page.
 *
 * @example
 * ```tsx
 * <ChartErrorBoundary>
 *   <MyChart data={data} />
 * </ChartErrorBoundary>
 * ```
 */
export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ChartErrorBoundary]", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset });
    }

    return (
      <div className="rounded-xl border bg-[hsl(var(--card))] p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-amber-600 dark:text-amber-400"
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

        <p className="mb-1 text-sm font-medium text-[hsl(var(--foreground))]">
          Failed to render this section
        </p>
        <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
          {error.message}
        </p>

        <button
          onClick={this.reset}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3.5 w-3.5"
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
          Retry
        </button>
      </div>
    );
  }
}
