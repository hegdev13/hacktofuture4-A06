"use client";

import { redirect } from "next/navigation";
import { useEffect } from "react";

export default function ConversationPage() {
  useEffect(() => {
    redirect("/dashboard");
  }, []);

  return null;
}
