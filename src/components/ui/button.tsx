"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({
  className,
  variant = "primary",
  disabled,
  ...props
}: Props) {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-indigo-500/60 disabled:opacity-60 disabled:cursor-not-allowed";
  const variants: Record<NonNullable<Props["variant"]>, string> = {
    primary:
      "bg-indigo-500 text-white hover:bg-indigo-400 border border-white/10",
    secondary:
      "bg-white/5 text-zinc-100 hover:bg-white/10 border border-white/10",
    danger: "bg-rose-500 text-white hover:bg-rose-400 border border-white/10",
    ghost: "bg-transparent text-zinc-100 hover:bg-white/5",
  };

  return (
    <button
      className={cn(base, variants[variant], className)}
      disabled={disabled}
      {...props}
    />
  );
}

