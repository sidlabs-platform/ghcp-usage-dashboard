"use client";

import { type LucideIcon } from "lucide-react";
import Link from "next/link";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="h-16 w-16 rounded-2xl bg-[hsl(var(--muted))] flex items-center justify-center mb-4">
        <Icon className="h-8 w-8 text-[hsl(var(--muted-foreground))]" />
      </div>
      <h3 className="text-lg font-semibold mb-1">{title}</h3>
      <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-sm mb-4">{description}</p>
      {action && (
        action.href ? (
          <Link href={action.href} className="text-sm font-medium text-[hsl(var(--primary))] hover:underline">
            {action.label} →
          </Link>
        ) : (
          <button onClick={action.onClick} className="text-sm font-medium text-[hsl(var(--primary))] hover:underline">
            {action.label}
          </button>
        )
      )}
    </div>
  );
}
