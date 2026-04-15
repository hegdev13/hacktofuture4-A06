import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireUserAndEndpoint(endpointId: string) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new Error("unauthorized");
  }

  const { data: endpoint, error } = await supabase
    .from("endpoints")
    .select("id,name,ngrok_url,user_id")
    .eq("id", endpointId)
    .eq("user_id", user.id)
    .single();

  if (error || !endpoint) {
    throw new Error("not_found");
  }

  return { user, endpoint, supabase };
}

export function toHttpStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "unauthorized") return 401;
  if (message === "not_found") return 404;
  return 500;
}
