/** Parse "30s" | "15m" | "6h" | "1d" into milliseconds. Returns null for unset/invalid. */
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return Math.round(value * factor);
}
