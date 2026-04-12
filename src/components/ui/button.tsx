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
    "inline-flex items-center justify-center rounded-full px-4 py-2.5 text-sm font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary/35 focus:ring-offset-2 focus:ring-offset-[#f7f2e8] disabled:opacity-60 disabled:cursor-not-allowed shadow-[0_8px_18px_rgba(66,86,96,0.1)]";
  const variants: Record<NonNullable<Props["variant"]>, string> = {
    primary:
      "bg-primary text-white hover:bg-primary-strong border border-primary/20",
    secondary:
      "bg-transparent text-primary-strong hover:bg-primary/10 border border-primary/35 shadow-none",
    danger: "bg-danger text-white hover:bg-[#b65150] border border-danger/25",
    ghost: "bg-transparent text-[#4a5964] hover:bg-[#ffffffb8] border border-transparent shadow-none",
  };

  return (
    <button
      className={cn(base, variants[variant], className)}
      disabled={disabled}
      {...props}
    />
  );
}

