export function formatNumber(n: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${formatNumber(v)} ${units[i]}`;
}

