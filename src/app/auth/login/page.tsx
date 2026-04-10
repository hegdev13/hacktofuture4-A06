"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const next = useMemo(() => {
    if (typeof window === "undefined") return "/dashboard";
    const n = new URLSearchParams(window.location.search).get("next");
    return n || "/dashboard";
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      localStorage.setItem("kubepulse.userEmail", email);
      localStorage.setItem("kubepulse.mockAuth", "1");
      if (!password) throw new Error("Password is required");
      toast.success("Welcome back");
      router.replace(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="text-lg font-semibold">Sign in</div>
        <div className="text-sm text-zinc-400">
          Monitor your clusters and self-healing signals in real time.
        </div>
      </CardHeader>
      <CardBody>
        <form className="space-y-3" onSubmit={onSubmit}>
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        <div className="mt-4 text-sm text-zinc-400">
          New here?{" "}
          <Link className="text-indigo-300 hover:underline" href="/auth/signup">
            Create an account
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

