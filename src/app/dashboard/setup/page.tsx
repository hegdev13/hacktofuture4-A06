"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  fetchEndpointsFromApi,
  setSelectedEndpointId,
  type Endpoint,
} from "@/lib/endpoints-client";

export default function SetupPage() {
  const [name, setName] = useState("");
  const [ngrokUrl, setNgrokUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);

  async function refresh() {
    const data = await fetchEndpointsFromApi();
    setEndpoints(data);
  }

  useEffect(() => {
    refresh().catch((e) => toast.error(e instanceof Error ? e.message : "Load failed"));
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ngrok_url: ngrokUrl }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Save failed");
      toast.success("Endpoint saved");
      setName("");
      setNgrokUrl("");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(endpointId: string) {
    setDeletingId(endpointId);
    try {
      const u = new URL("/api/endpoints", window.location.origin);
      u.searchParams.set("id", endpointId);
      const res = await fetch(u.toString(), { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Delete failed");
      window.dispatchEvent(new Event("kubepulse-endpoint"));
      toast.success("Endpoint deleted");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Dashboard setup</div>
          <div className="text-sm text-muted">
            Add one or more ngrok endpoints exposing your Kubernetes metrics API.
          </div>
        </CardHeader>
        <CardBody>
          <form className="space-y-3" onSubmit={onCreate}>
            <Input
              label="Endpoint name"
              placeholder="minikube-online-boutique"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              label="ngrok URL"
              placeholder="https://abcd-12-34-56-78.ngrok-free.app"
              value={ngrokUrl}
              onChange={(e) => setNgrokUrl(e.target.value)}
              required
              hint="Paste tunnel base URL or full URL like /pods?include_logs=true&log_tail=20; app normalizes and uses it dynamically."
            />
            <Button type="submit" disabled={saving} className="w-full">
              {saving ? "Saving..." : "Save endpoint"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-2xl font-bold tracking-tight text-[#1f2b33]">Your endpoints</div>
          <div className="text-sm text-muted">
            Select one from the top bar to view metrics.
          </div>
        </CardHeader>
        <CardBody>
          {endpoints.length ? (
            <div className="space-y-3">
              {endpoints.map((ep) => (
                <div
                  key={ep.id}
                  className="rounded-2xl bg-[#fffdf8] p-4 shadow-[0_10px_22px_rgba(70,86,94,0.09)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#24323c]">{ep.name}</div>
                      <div className="truncate text-xs text-muted">
                        {ep.ngrok_url}
                      </div>
                    </div>
                    <a
                      className="rounded-full border border-primary/30 px-3 py-1 text-xs font-semibold text-primary-strong transition hover:bg-primary/10"
                      href={`/dashboard`}
                      onClick={() => {
                        setSelectedEndpointId(ep.id);
                      }}
                    >
                      Open
                    </a>
                    <Button
                      type="button"
                      variant="danger"
                      className="px-2 py-1 text-xs"
                      disabled={deletingId === ep.id}
                      onClick={() => onDelete(ep.id)}
                    >
                      {deletingId === ep.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted">
              No endpoints yet. Add one on the left.
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

