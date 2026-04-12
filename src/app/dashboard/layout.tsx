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
      <div className="min-h-screen p-6 md:p-10">
        <div className="mx-auto max-w-2xl rounded-2xl border border-[#e7ddcd] bg-[#fff9f0] p-6 shadow-[0_16px_34px_rgba(63,74,83,0.09)]">
          <h1 className="text-2xl font-bold tracking-tight text-[#1f2b33]">Supabase environment is not configured</h1>
          <p className="mt-3 text-sm text-[#5d6973]">
            Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env.local, then restart the dev server.
          </p>
        </div>
      </div>
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

