import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { DashboardShell } from "@/components/layout/DashboardShell";
import CommandPalette from "@/components/ui/CommandPalette";
import { DateRangeProvider } from "@/contexts/DateRangeContext";
import { ScopeProvider } from "@/contexts/ScopeContext";
import { QueryProvider } from "@/components/providers/QueryProvider";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <DateRangeProvider>
        <ScopeProvider>
          <DashboardShell>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex flex-1 flex-col overflow-hidden">
                <Header />
                <main className="flex-1 overflow-y-auto p-6 bg-[hsl(var(--background))]">
                  {children}
                </main>
              </div>
            </div>
            <CommandPalette />
          </DashboardShell>
        </ScopeProvider>
      </DateRangeProvider>
    </QueryProvider>
  );
}
