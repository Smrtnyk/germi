export type FindScope = "all" | "url" | "headers" | "body";
export type FindRegion = "url" | "header" | "body";

export interface InspectorFindHandle {
  openFind: (seed?: string, scope?: FindScope) => void;
  step: (dir: number) => void;
  open: boolean;
}

export interface RegionLocation {
  region: FindRegion;
  localIndex: number;
  field?: 0 | 1;
  occ?: number;
}

export interface HeaderMatch {
  row: number;
  field: 0 | 1;
  occ: number;
}

export interface CombinedMatches {
  total: number;
  url: number;
  headers: HeaderMatch[];
  body: number;
  regionForIndex: (i: number) => RegionLocation | null;
}

export function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

export function countOccurrences(haystack: string, query: string, caseSensitive = false): number {
  if (!query) return 0;
  const hay = fold(haystack, caseSensitive);
  const q = fold(query, caseSensitive);
  let count = 0;
  let from = hay.indexOf(q);
  while (from !== -1) {
    count++;
    from = hay.indexOf(q, from + q.length);
  }
  return count;
}

export function bodyOccurrences(
  rows: string[],
  query: string,
  caseSensitive = false,
): { line: number; occ: number }[] {
  if (query.length < 1) return [];
  const q = fold(query, caseSensitive);
  const res: { line: number; occ: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const hay = fold(rows[i], caseSensitive);
    let occ = 0;
    let from = hay.indexOf(q);
    while (from !== -1) {
      res.push({ line: i, occ });
      occ++;
      if (res.length >= 5000) return res;
      from = hay.indexOf(q, from + q.length);
    }
  }
  return res;
}

export function headerMatches(
  headers: [string, string][],
  query: string,
  caseSensitive = false,
): HeaderMatch[] {
  if (!query) return [];
  const out: HeaderMatch[] = [];
  for (let row = 0; row < headers.length; row++) {
    const names = countOccurrences(headers[row][0], query, caseSensitive);
    for (let occ = 0; occ < names; occ++) out.push({ row, field: 0, occ });
    const values = countOccurrences(headers[row][1], query, caseSensitive);
    for (let occ = 0; occ < values; occ++) out.push({ row, field: 1, occ });
  }
  return out;
}

export function combineMatches(
  url: string,
  headers: [string, string][],
  bodyCount: number,
  query: string,
  scope: FindScope,
  caseSensitive = false,
): CombinedMatches {
  const wantUrl = scope === "all" || scope === "url";
  const wantHeaders = scope === "all" || scope === "headers";
  const wantBody = scope === "all" || scope === "body";

  const urlCount = query && wantUrl ? countOccurrences(url, query, caseSensitive) : 0;
  const hits = query && wantHeaders ? headerMatches(headers, query, caseSensitive) : [];
  const body = query && wantBody ? bodyCount : 0;
  const total = urlCount + hits.length + body;

  const regionForIndex = (i: number): RegionLocation | null => {
    if (i < 0 || i >= total) return null;
    if (i < urlCount) return { region: "url", localIndex: i };
    const h = i - urlCount;
    if (h < hits.length) {
      const m = hits[h];
      return { region: "header", localIndex: m.row, field: m.field, occ: m.occ };
    }
    return { region: "body", localIndex: i - urlCount - hits.length };
  };

  return { total, url: urlCount, headers: hits, body, regionForIndex };
}
