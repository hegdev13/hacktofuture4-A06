"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function DashboardLayoutClient({
  userEmail,
  children,
}: {
  userEmail?: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/dashboard";

  return (
    <div className="flex flex-1 min-h-[calc(100vh-0px)]">
      <Sidebar activePath={pathname} userEmail={userEmail} />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

