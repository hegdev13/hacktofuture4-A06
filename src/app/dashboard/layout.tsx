import { DashboardLayoutClient } from "@/components/dashboard/dashboard-layout-client";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hasSupabaseEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!hasSupabaseEnv) {
    return (
      <DashboardLayoutClient userEmail="Demo mode">
        <div className="mb-6 rounded-2xl border border-[#e7ddcd] bg-[#fff9f0] p-4 shadow-[0_12px_26px_rgba(63,74,83,0.08)]">
          <h1 className="text-2xl font-bold tracking-tight text-[#1f2b33]">
            Dashboard demo mode
          </h1>
          <p className="mt-2 text-sm text-[#5d6973]">
            Supabase env vars are missing, so the dashboard is rendering in demo mode instead of blocking the route.
            Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local to enable live data.
          </p>
        </div>
        {children}
      </DashboardLayoutClient>
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login?next=/dashboard");
  }

  return <DashboardLayoutClient userEmail={user.email}>{children}</DashboardLayoutClient>;
}

