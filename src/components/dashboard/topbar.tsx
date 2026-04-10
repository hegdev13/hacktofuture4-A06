import { EndpointPicker } from "./endpoint-picker";

export function Topbar() {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/10 px-4 py-3">
      <div className="text-sm text-zinc-400">
        Real-time Kubernetes observability (Supabase + ngrok)
      </div>
      <EndpointPicker />
    </div>
  );
}

