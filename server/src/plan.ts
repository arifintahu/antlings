import type { PlanUsage, PlanWindow } from '@antlings/shared';
import type { AgentHandle, RawPlanUsage } from './agent.js';

const clampPercent = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

function windowFrom(
  w: { utilization: number | null; resets_at: string | null } | null | undefined,
): PlanWindow | null {
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  // The usage call reports 0 to 100.
  return { percent: clampPercent(w.utilization), resetsAt: w.resets_at ?? null };
}

export function normalizePlanUsage(raw: RawPlanUsage | null | undefined): PlanUsage {
  if (!raw || raw.rate_limits_available !== true || !raw.rate_limits) return { status: 'unavailable' };
  const fiveHour = windowFrom(raw.rate_limits.five_hour);
  const sevenDay = windowFrom(raw.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return { status: 'unavailable' };
  return { status: 'ok', fiveHour, sevenDay };
}

/** One adapter around the experimental SDK call. Any failure becomes `unavailable`. */
export async function fetchPlanUsage(handle: AgentHandle): Promise<PlanUsage> {
  try {
    return normalizePlanUsage(await handle.planUsage());
  } catch {
    return { status: 'unavailable' };
  }
}

export interface RateLimitInfo {
  rateLimitType?: string;
  /** A fraction: 0.5 means 50 percent. The usage call above uses 0 to 100. */
  utilization?: number;
  resetsAt?: number;
}

/** Merges a `rate_limit_event` into the last known usage. Returns null when the event carries no window. */
export function mergeRateLimit(prev: PlanUsage, info: RateLimitInfo): PlanUsage | null {
  const key =
    info.rateLimitType === 'five_hour' ? 'fiveHour' : info.rateLimitType === 'seven_day' ? 'sevenDay' : null;
  if (!key || typeof info.utilization !== 'number' || !Number.isFinite(info.utilization)) return null;
  const resetsAt =
    typeof info.resetsAt === 'number'
      ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString()
      : null;
  const next: PlanWindow = { percent: clampPercent(info.utilization * 100), resetsAt };
  const base = prev.status === 'ok' ? prev : { status: 'ok' as const, fiveHour: null, sevenDay: null };
  return { ...base, [key]: next };
}
