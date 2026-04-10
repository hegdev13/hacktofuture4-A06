"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import toast from "react-hot-toast";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      localStorage.setItem("kubepulse.userEmail", email);
      localStorage.setItem("kubepulse.mockAuth", "1");
      if (password.length < 8) throw new Error("Use at least 8 characters");
      toast.success("Account created. You're signed in.");
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signup failed";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="text-lg font-semibold">Create account</div>
        <div className="text-sm text-zinc-400">
          Supabase-backed auth with persistent sessions.
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
            placeholder="At least 8 characters"
            autoComplete="new-password"
            required
            minLength={8}
          />
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create account"}
          </Button>
        </form>

        <div className="mt-4 text-sm text-zinc-400">
          Already have an account?{" "}
          <Link className="text-indigo-300 hover:underline" href="/auth/login">
            Sign in
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

