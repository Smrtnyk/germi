import { clamp } from "es-toolkit";

const RAIL_RGB = "45, 212, 191";
const FLOOR = 0.35;
const SATURATED = 0.95;

export function railBands(ids: string[], matched: Set<string>, bandCount: number): number[] {
  const n = ids.length;
  if (n === 0 || bandCount <= 0) return [];
  const b = Math.min(bandCount, n);
  const hit = new Array<number>(b).fill(0);
  const total = new Array<number>(b).fill(0);
  for (let i = 0; i < n; i++) {
    const k = Math.min(b - 1, Math.floor((i * b) / n));
    total[k] += 1;
    if (matched.has(ids[i])) hit[k] += 1;
  }
  return hit.map((h, k) => (total[k] > 0 ? h / total[k] : 0));
}

export function bandsToGradient(bands: number[]): string {
  if (bands.length === 0) return "transparent";
  const b = bands.length;
  const stops: string[] = [];
  for (let k = 0; k < b; k++) {
    const intensity = bands[k];
    const color =
      intensity > 0
        ? `rgba(${RAIL_RGB}, ${(FLOOR + (1 - FLOOR) * intensity).toFixed(3)})`
        : "transparent";
    stops.push(
      `${color} ${((k / b) * 100).toFixed(2)}%`,
      `${color} ${(((k + 1) / b) * 100).toFixed(2)}%`,
    );
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

export function indexForFraction(fraction: number, total: number): number {
  if (total <= 0) return 0;
  const f = clamp(fraction, 0, 1);
  return clamp(Math.round(f * (total - 1)), 0, total - 1);
}

export function railVisible(matchCount: number, total: number): boolean {
  if (matchCount <= 0 || total <= 0) return false;
  return matchCount / total < SATURATED;
}
