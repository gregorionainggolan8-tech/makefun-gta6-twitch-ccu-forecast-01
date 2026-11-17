// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only): a comparable-curve forecaster.
//
// Model: every past big launch in the case's `comparables` has a full 24-hour release-day curve.
// For each usable comparable we take its log-ratio curve against its own hour 1,
//   r_h = ln(viewers_h / viewers_1),  h = 2..24,
// and combine the curves into one forecast for the target launch, anchored on the target's
// hour-1 print p1:
//
//   * Post-unlock filter. A launch whose hour 1 was still before its unlock has a tiny hour 1
//     and an exploding ratio curve (up to ~2000x), which says nothing about a launch whose
//     hour 1 is already live. A comparable is kept only when its release day is complete
//     (all 24 hourly points, all > 0), its hour 1 is at least 1,000 viewers, and its hour 1
//     is at least 0.8x its own pre-release 24-hour median (hour 1 already at/above the
//     pre-release level). The target's own hour 1 in every practice case is 1.5-1.7x its
//     pre-release median, so this is the regime the entry will actually face.
//   * Scale weighting. Curve shape depends strongly on launch scale (big launches sustain
//     and grow into the US evening; small ones fade). Each comparable gets a Gaussian kernel
//     weight in log hour-1 scale, w = exp(-ln(v1/p1)^2 / (2 * 1.0^2)), so launches near the
//     target's size dominate. The per-hour median is the weighted median of the r_h values.
//   * Smoothing. The median curve is lightly smoothed (0.25/0.5/0.25 across neighbouring
//     hours); the shape (dip in hours 2-5, rise from hour 6 as the US unlocks roll in, peak
//     around hours 19-21) is real and shared by rolling-midnight console launches.
//   * Spread. The per-hour log spread is the weighted MAD (x1.4826) of the r_h values around
//     the weighted median, clamped to [0.40, 0.90]: the floor matters because even hours
//     where the median is stable still vary a lot launch to launch. Quantiles are
//     q_tau = p1 * exp(m_h + z_tau * sigma_h), z the standard normal quantiles.
//   * Fallback. If fewer than 3 usable curves exist, fall back to the house persistence
//     baseline (every hour at p1, spread 0.15*sqrt(h-1)), so the output is always valid.
//
// The program only reads the case file it is given: the model is fitted from that case's
// comparables at run time. The only constants are the filter thresholds, kernel width and
// spread clamps above, chosen by leave-one-out validation over the comparables in the
// practice cases (see README): LOO pinball loss ~0.38 on post-unlock launches vs ~0.72 for
// the persistence baseline on the same set.
//
// I/O: reads every <id>.in in $MAKEFUN_INPUT_DIR (else /input), writes <id>.out to
// $MAKEFUN_OUTPUT_DIR (else /output): {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]},
// 23 rows, hours 2..24. Deterministic: pure functions, sorted file order, no randomness,
// no network, no model calls.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Gaussian kernel width (log units) for weighting comparables by hour-1 scale. */
const SCALE_KERNEL = 1.0;
/** A comparable's hour 1 must be at least this many viewers to be usable. */
const MIN_HOUR1 = 1000;
/** A comparable's hour 1 must be at least this fraction of its pre-release median. */
const MIN_HOUR1_TO_BASE = 0.8;
/** Clamp on the per-hour log spread. */
const SIGMA_FLOOR = 0.4;
const SIGMA_CAP = 0.9;
/** Minimum usable curves before falling back to the persistence baseline. */
const MIN_CURVES = 3;
/** The persistence baseline's spread, used only by the fallback. */
const BASELINE_SIGMA = 0.15;

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }> | { hour: number; viewers: number };
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Median of a non-empty list. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Weighted median of [value, weight] pairs (weights > 0). */
const weightedMedian = (pairs: Array<[number, number]>): number => {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return s[s.length - 1][0];
};

/** Weighted median absolute deviation (x1.4826) of [deviation, weight] pairs. */
const weightedMadSigma = (pairs: Array<[number, number]>): number => {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) {
    acc += w;
    if (acc >= total / 2) return 1.4826 * v;
  }
  return 1.4826 * s[s.length - 1][0];
};

/** A comparable's release-day curve: hour (1..24, relative to day_start) -> viewers (> 0). */
const dayCurve = (comp: Comparable): Map<number, number> => {
  const ds = Date.parse(comp.day_start);
  const by = new Map<number, number>();
  if (!Array.isArray(comp.hourly)) return by;
  for (const pt of comp.hourly) {
    if (typeof pt.viewers !== 'number' || pt.viewers <= 0) continue;
    const h = Math.round((Date.parse(pt.from) - ds) / 3600000) + 1;
    if (h >= 1 && h <= 24) by.set(h, pt.viewers);
  }
  return by;
};

/** Median viewers in the 24 hours before the comparable's release day (null if none). */
const preReleaseMedian = (comp: Comparable): number | null => {
  const ds = Date.parse(comp.day_start);
  const vals: number[] = [];
  if (!Array.isArray(comp.hourly)) return null;
  for (const pt of comp.hourly) {
    const t = Date.parse(pt.from);
    if (t >= ds - 86400000 && t < ds && typeof pt.viewers === 'number' && pt.viewers > 0) vals.push(pt.viewers);
  }
  return vals.length === 0 ? null : median(vals);
};

interface Curve {
  logRatio: number[]; // index h (2..24): ln(viewers_h / viewers_1)
  weight: number;
}

/** The usable comparable curves for a target whose hour-1 print is p1. */
const usableCurves = (comps: Comparable[], p1: number): Curve[] => {
  const curves: Curve[] = [];
  for (const comp of comps) {
    const by = dayCurve(comp);
    if (by.size < 24 || !by.has(1)) continue;
    const v1 = by.get(1) as number;
    if (v1 < MIN_HOUR1) continue;
    const base = preReleaseMedian(comp);
    if (base !== null && v1 < MIN_HOUR1_TO_BASE * base) continue;
    const d = Math.log(v1 / p1);
    const weight = Math.exp(-(d * d) / (2 * SCALE_KERNEL * SCALE_KERNEL));
    const logRatio: number[] = [];
    for (let h = 2; h <= 24; h++) logRatio[h] = Math.log((by.get(h) as number) / v1);
    curves.push({ logRatio, weight });
  }
  return curves;
};

/** The persistence baseline's quantiles for one hour (fallback only). */
const baselineQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(Math.max(1, p1 * Math.exp(z * BASELINE_SIGMA * Math.sqrt(h - 1)))));

/** Forecast one case: 23 rows of five quantiles for hours 2..24. */
const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  const knownRow = Array.isArray(c.known) ? c.known.find((k) => k.hour === 1) : c.known;
  if (knownRow === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, knownRow.viewers);
  const curves = usableCurves(c.comparables ?? [], p1);

  if (curves.length < MIN_CURVES) {
    return c.forecast.map(({ hour }) => ({ hour, q: baselineQuantiles(p1, hour) }));
  }

  // Weighted median log-ratio per hour, lightly smoothed across neighbouring hours.
  const med: number[] = [];
  for (let h = 2; h <= 24; h++) {
    med[h] = weightedMedian(curves.map((cv) => [cv.logRatio[h], cv.weight] as [number, number]));
  }
  const smooth: number[] = [];
  for (let h = 2; h <= 24; h++) {
    const a = med[h - 1] ?? med[h];
    const cc = med[h + 1] ?? med[h];
    smooth[h] = 0.25 * a + 0.5 * med[h] + 0.25 * cc;
  }

  return c.forecast.map(({ hour: h }) => {
    const sigmaRaw = weightedMadSigma(
      curves.map((cv) => [Math.abs(cv.logRatio[h] - med[h]), cv.weight] as [number, number]),
    );
    const sigma = Math.max(SIGMA_FLOOR, Math.min(SIGMA_CAP, sigmaRaw));
    const q = Z.map((z) => round2(Math.min(1e9, Math.max(1, p1 * Math.exp(smooth[h] + z * sigma)))));
    // Keep the row non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { hour: h, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
