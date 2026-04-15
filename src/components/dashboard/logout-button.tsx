"use client";

import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const router = useRouter();

  return (
    <Button
      variant="ghost"
      className="w-full justify-start"
      onClick={async () => {
        try {
          const res = await fetch("/logout", { method: "POST" });
          if (!res.ok) {
            const data = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(data?.error || "Logout failed");
          }
          router.replace("/auth/login");
          router.refresh();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Logout failed");
        }
      }}
    >
      Logout
    </Button>
  );
}

