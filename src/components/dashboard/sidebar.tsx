import Link from "next/link";
import { Activity, Bell, LayoutDashboard, ScrollText, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoutButton } from "./logout-button";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/metrics", label: "Metrics", icon: Activity },
  { href: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
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
    <aside className="flex h-full w-64 flex-col border-r border-white/10 bg-black/20">
      <div className="p-4 border-b border-white/10">
        <div className="text-lg font-semibold tracking-tight">KubePulse</div>
        <div className="mt-1 text-xs text-zinc-400">
          {userEmail ? userEmail : "Signed in"}
        </div>
      </div>

      <nav className="flex-1 p-2 space-y-1">
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
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-200 hover:bg-white/5",
                isActive ? "bg-white/10 text-white" : null,
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-2 border-t border-white/10">
        <LogoutButton />
      </div>
    </aside>
  );
}

