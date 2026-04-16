import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CreateEndpointSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/security/rate-limit";

type LocalEndpoint = {
  id: string;
  name: string;
  ngrok_url: string;
  created_at: string;
};

const localEndpoints: LocalEndpoint[] = [];

function hasSupabaseEnv() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

const DeleteQuerySchema = z.object({
  id: z.string().uuid(),
});

function schemaErrorMessage(message: string) {
  if (message.includes("Could not find the table 'public.endpoints'")) {
    return "Database schema is not initialized. Run supabase/sql/001_init.sql in your Supabase SQL Editor.";
  }
  return message;
}

export async function GET() {
  const rl = rateLimit({
    key: `endpoints:${"global"}`,
    limit: 600,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  if (!hasSupabaseEnv()) {
    return NextResponse.json({
      endpoints: localEndpoints,
      mode: "local-dev",
    });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("endpoints")
    .select("id,name,ngrok_url,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: schemaErrorMessage(error.message) }, { status: 500 });
  }

  return NextResponse.json({ endpoints: data ?? [] });
}

export async function POST(request: Request) {
  const rl = rateLimit({
    key: `endpoints:${request.headers.get("x-forwarded-for") || "unknown"}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = CreateEndpointSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!hasSupabaseEnv()) {
    const endpoint: LocalEndpoint = {
      id: crypto.randomUUID(),
      name: parsed.data.name,
      ngrok_url: parsed.data.ngrok_url,
      created_at: new Date().toISOString(),
    };
    localEndpoints.unshift(endpoint);
    return NextResponse.json({ endpoint, mode: "local-dev" });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("endpoints")
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      ngrok_url: parsed.data.ngrok_url,
    })
    .select("id,name,ngrok_url,created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: schemaErrorMessage(error.message) }, { status: 500 });
  }

  return NextResponse.json({ endpoint: data });
}

export async function DELETE(request: Request) {
  const rl = rateLimit({
    key: `endpoints-delete:${request.headers.get("x-forwarded-for") || "unknown"}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const url = new URL(request.url);
  const parsed = DeleteQuerySchema.safeParse({ id: url.searchParams.get("id") });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!hasSupabaseEnv()) {
    const idx = localEndpoints.findIndex((ep) => ep.id === parsed.data.id);
    if (idx !== -1) {
      localEndpoints.splice(idx, 1);
    }
    return NextResponse.json({ ok: true, mode: "local-dev" });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("endpoints")
    .delete()
    .eq("id", parsed.data.id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: schemaErrorMessage(error.message) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

