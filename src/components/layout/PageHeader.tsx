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

export function PageHeader({ title, description, children, hideScope }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
          {description && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{description}</p>
          )}
        </div>
        {children && <div className="flex items-center gap-2">{children}</div>}
      </div>
      {!hideScope && (
        <div className="mt-3 border-t border-[hsl(var(--border))] pt-2.5">
          <ScopeSummary />
        </div>
      )}
    </div>
  );
}
