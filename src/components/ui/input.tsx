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
        <div className="mb-1 text-sm font-medium text-zinc-200">{label}</div>
      ) : null}
      <input
        className={cn(
          "w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60",
          error ? "border-rose-500/60" : null,
          className,
        )}
        {...props}
      />
      {error ? (
        <div className="mt-1 text-xs text-rose-300">{error}</div>
      ) : hint ? (
        <div className="mt-1 text-xs text-zinc-400">{hint}</div>
      ) : null}
    </label>
  );
}

