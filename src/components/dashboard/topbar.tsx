import { EndpointPicker } from "./endpoint-picker";

export function Topbar() {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#e8dece] bg-[#f7f1e7]/80 px-5 py-4 backdrop-blur-sm md:px-8">
      <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1.5 text-xs font-medium text-muted shadow-[0_8px_16px_rgba(70,86,94,0.08)] md:text-sm">
        <span className="h-2 w-2 rounded-full bg-primary" />
        Real-time Kubernetes observability (Supabase + ngrok)
      </div>
      <EndpointPicker />
    </div>
  );
}

