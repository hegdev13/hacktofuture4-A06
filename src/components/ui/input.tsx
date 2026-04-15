"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function Input({ className, label, hint, error, ...props }: Props) {
  return (
    <label className="block">
      {label ? (
        <div className="mb-2 text-sm font-semibold text-[#2d3942]">{label}</div>
      ) : null}
      <input
        className={cn(
          "w-full rounded-xl border border-[#e8ddcc] bg-[#fffdf8] px-4 py-2.5 text-sm text-[#22303a] placeholder:text-[#8b959f] shadow-[inset_0_1px_1px_rgba(255,255,255,0.6)] focus:outline-none focus:ring-2 focus:ring-primary/35",
          error ? "border-danger/55" : null,
          className,
        )}
        {...props}
      />
      {error ? (
        <div className="mt-1 text-xs text-danger">{error}</div>
      ) : hint ? (
        <div className="mt-1 text-xs text-muted">{hint}</div>
      ) : null}
    </label>
  );
}

