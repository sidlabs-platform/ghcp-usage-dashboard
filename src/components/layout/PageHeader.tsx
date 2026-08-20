import { ScopeSummary } from "./ScopeSummary";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  /**
   * Hide the scope/date provenance line. Only for surfaces whose figures are
   * genuinely neither scope- nor date-dependent (settings, configuration).
   */
  hideScope?: boolean;
}

/**
 * Page-level header rendered at the top of every dashboard page.
 *
 * The `title` is the **only `<h1>` on the page** (#101 heading semantics fix).
 * The app brand in the persistent header is a `<p>` so every page has exactly
 * one `<h1>` that names the current page.
 */
export function PageHeader({ title, description, children, hideScope }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{description}</p>
          )}
        </div>
        {children && (
          <div className="flex flex-wrap items-center gap-2">{children}</div>
        )}
      </div>
      {!hideScope && (
        <div className="mt-3 border-t border-[hsl(var(--border))] pt-2.5">
          <ScopeSummary />
        </div>
      )}
    </div>
  );
}
