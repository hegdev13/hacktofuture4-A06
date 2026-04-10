"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { loadEndpoints, saveEndpoint } from "@/lib/frontend-mock";

type Endpoint = {
  id: string;
  name: string;
  ngrok_url: string;
  created_at: string;
};

export default function SetupPage() {
  const [name, setName] = useState("");
  const [ngrokUrl, setNgrokUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);

  async function refresh() {
    setEndpoints(loadEndpoints() as Endpoint[]);
  }

  useEffect(() => {
    refresh().catch((e) => toast.error(e instanceof Error ? e.message : "Load failed"));
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      saveEndpoint(name, ngrokUrl);
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

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Dashboard setup</div>
          <div className="text-sm text-zinc-400">
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
              hint="We validate that this is an https ngrok URL."
            />
            <Button type="submit" disabled={saving} className="w-full">
              {saving ? "Saving..." : "Save endpoint"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-lg font-semibold">Your endpoints</div>
          <div className="text-sm text-zinc-400">
            Select one from the top bar to view metrics.
          </div>
        </CardHeader>
        <CardBody>
          {endpoints.length ? (
            <div className="space-y-2">
              {endpoints.map((ep) => (
                <div
                  key={ep.id}
                  className="rounded-lg border border-white/10 bg-black/10 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{ep.name}</div>
                      <div className="truncate text-xs text-zinc-400">
                        {ep.ngrok_url}
                      </div>
                    </div>
                    <a
                      className="text-xs text-indigo-300 hover:underline"
                      href={`/dashboard`}
                      onClick={() => localStorage.setItem("kubepulse.endpointId", ep.id)}
                    >
                      Open
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-zinc-400">
              No endpoints yet. Add one on the left.
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

