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
      onClick={() => {
        try {
          localStorage.removeItem("kubepulse.mockAuth");
          localStorage.removeItem("kubepulse.userEmail");
          router.replace("/auth/login");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Logout failed");
        }
      }}
    >
      Logout
    </Button>
  );
}

