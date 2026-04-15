export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-1 items-center justify-center px-5 py-12 md:px-8">
      <div className="grid w-full max-w-6xl items-center gap-10 lg:grid-cols-2">
        <section className="space-y-6">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary-strong">
            Kubernetes Observability
          </span>
          <h1 className="max-w-xl text-4xl font-extrabold leading-tight tracking-tight text-[#1c2830] md:text-6xl">
            See your <span className="text-primary-strong">cluster health</span> and <span className="text-accent">self-healing signals</span> in one calm command center.
          </h1>
          <p className="max-w-lg text-base text-muted md:text-lg">
            Sign in to continue monitoring your pods and real-time infrastructure behavior.
          </p>

          <div className="w-full max-w-md rounded-2xl border border-[#e6ddcf] bg-[#fffaf2] p-5 shadow-[0_24px_46px_rgba(52,72,84,0.14)]">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Live Terminal</div>
              <span className="rounded-full bg-accent/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">active</span>
            </div>
            <div className="space-y-2 rounded-xl bg-[#f3efe7] p-4 font-mono text-xs text-[#33424d]">
              <div className="flex items-center justify-between"><span className="text-[#6a7480]">namespace</span><span>production</span></div>
              <div className="flex items-center justify-between"><span className="text-[#6a7480]">pods</span><span>34 running</span></div>
              <div className="flex items-center justify-between"><span className="text-[#6a7480]">alerts</span><span className="text-accent">2 medium</span></div>
              <div className="flex items-center justify-between"><span className="text-[#6a7480]">healing</span><span className="text-primary-strong">stable</span></div>
            </div>
          </div>
        </section>

        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}

