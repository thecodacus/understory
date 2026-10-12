import { parseDuration, runDream, type KnowledgeBase } from "@understory/core";

const MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Background dreamer: runs a consolidation pass every DREAM_INTERVAL
 * (e.g. "6h"). Opt-in — unset means no background token spend. The first
 * run happens one interval after boot, never at startup.
 */
export function startDreamer(kb: KnowledgeBase): void {
  const raw = process.env.DREAM_INTERVAL;
  const interval = parseDuration(raw);
  if (!interval) {
    if (raw) console.error(`[understory] invalid DREAM_INTERVAL "${raw}" — dreaming disabled`);
    else console.log("[understory] dreaming: disabled (set DREAM_INTERVAL, e.g. 6h, to enable)");
    return;
  }
  const every = Math.max(interval, MIN_INTERVAL_MS);
  console.log(`[understory] dreaming: every ${raw}${every !== interval ? " (clamped to 5m minimum)" : ""}`);

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // never overlap dreams
    busy = true;
    try {
      const report = await runDream(kb);
      if (report.ran) {
        console.log(
          `[understory] dream complete: ${report.filesChanged?.length ?? 0} file(s) changed — ${truncate(report.summary ?? "", 200)}`
        );
      } else {
        console.log(`[understory] dream skipped: ${report.reason}`);
      }
    } catch (err) {
      console.error(`[understory] dream failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, every);
  timer.unref(); // never keep the process alive just to dream
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
