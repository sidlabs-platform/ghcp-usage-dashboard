import * as React from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function Section({ title, description, children, className }: SectionProps) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {title}
        </h2>
        {description && (
          <p className="text-xs text-[hsl(var(--muted-foreground) / 0.7)]">{description}</p>
        )}
        <div
          className="h-px w-full"
          style={{
            background:
              "linear-gradient(to right, hsl(var(--accent-foreground) / 0.2), transparent)",
          }}
        />
      </div>
      {children}
    </section>
  );
}
