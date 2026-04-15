import Link from "next/link";
import { Activity, Bell, BrainCircuit, LayoutDashboard, Network, ScrollText, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoutButton } from "./logout-button";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/metrics", label: "Metrics", icon: Activity },
  { href: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
  { href: "/dashboard/dependency", label: "Dependency Graph", icon: Network },
  { href: "/dashboard/healing", label: "AI Healing", icon: BrainCircuit },
  { href: "/dashboard/setup", label: "Setup", icon: Settings2 },
];

export function Sidebar({
  activePath,
  userEmail,
}: {
  activePath: string;
  userEmail?: string | null;
}) {
  return (
    <aside className="flex h-full w-72 flex-col border-r border-[#e6dccb] bg-[#f9f3e9]/70 backdrop-blur-sm">
      <div className="border-b border-[#e8dece] p-6">
        <div className="text-2xl font-extrabold tracking-tight text-[#1f2b33]">KubePulse</div>
        <div className="mt-1 text-xs text-muted">
          {userEmail ? userEmail : "Signed in"}
        </div>
      </div>

      <nav className="flex-1 space-y-2 p-4">
        {nav.map((item) => {
          const isActive =
            activePath === item.href ||
            (item.href !== "/dashboard" && activePath.startsWith(item.href));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-[#51606b] transition-colors duration-200 hover:bg-white/70",
                isActive
                  ? "bg-white text-primary-strong shadow-[0_10px_20px_rgba(65,84,94,0.12)]"
                  : null,
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[#e8dece] p-4">
        <LogoutButton />
      </div>
    </aside>
  );
}

