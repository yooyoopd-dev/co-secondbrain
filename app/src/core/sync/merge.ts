// 3-way 병합. HUB.md §5 — 409 응답이 돌려주는 세 조각(기준 · 서버 · 내 것)을 합친다.
//
// 라이브러리를 쓰지 않는다. diff3 는 LCS 두 번과 구간 비교로 끝나고, 사내 오프라인
// 설치에서 의존성 하나가 곧 배포 비용이다 (diff.ts 와 같은 판단).
//
// LCS 표를 diff.ts 와 따로 짠 이유: 여기서는 줄 종류가 아니라 **줄 번호 대응**이
// 필요하다. diff.ts 를 고쳐 두 용도를 겸하게 만들면 승인 화면의 diff 가 같이 흔들린다.

/** 이 줄 수를 넘으면 LCS 표(줄수²)가 커진다. 위키 페이지는 보통 수십 줄이다. */
export const MAX_LINES = 2000;

export type MergeChunk =
  | { kind: 'stable'; lines: string[] }
  /** 내 쪽만 고친 구간 */
  | { kind: 'mine'; lines: string[] }
  /** 서버 쪽만 고친 구간 */
  | { kind: 'theirs'; lines: string[] }
  | { kind: 'conflict'; base: string[]; mine: string[]; theirs: string[] };

export interface Merge3 {
  chunks: MergeChunk[];
  /** 충돌 구간 수. 0 이면 clean */
  conflicts: number;
  clean: boolean;
  /** 병합 결과 전문. 충돌이 있으면 표시가 들어간다 */
  text: string;
}

export const MARK_MINE = '<<<<<<< 내 것';
export const MARK_BASE = '||||||| 기준';
export const MARK_SPLIT = '=======';
export const MARK_THEIRS = '>>>>>>> 서버';

function split(s: string): string[] {
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

/**
 * a 의 각 줄이 b 의 몇 번째 줄에 대응하는지. 대응이 없으면 -1.
 * LCS 라서 대응은 단조 증가한다 — 병합 walk 가 그 성질에 기댄다.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): number[] {
  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const lcs = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out = new Array<number>(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

const same = (x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * 기준(base)에서 갈라진 두 판본을 합친다.
 *
 * 한쪽만 고친 구간은 그쪽을 따르고, 양쪽이 같은 고침을 냈으면 한 번만 넣는다.
 * 양쪽이 서로 다르게 고친 구간만 충돌이다. **충돌을 임의로 고르지 않는다** —
 * 표시를 남기고 사람에게 넘긴다.
 */
export function merge3(base: string, mine: string, theirs: string): Merge3 {
  const b = split(base);
  const m = split(mine);
  const t = split(theirs);

  if (b.length > MAX_LINES || m.length > MAX_LINES || t.length > MAX_LINES) {
    const chunks: MergeChunk[] = [{ kind: 'conflict', base: b, mine: m, theirs: t }];
    return { chunks, conflicts: 1, clean: false, text: render(chunks, endsNl(mine, theirs)) };
  }

  const toMine = lcsPairs(b, m);
  const toTheirs = lcsPairs(b, t);

  const chunks: MergeChunk[] = [];
  let bi = 0;
  let mi = 0;
  let ti = 0;

  const flushUnstable = (bEnd: number, mEnd: number, tEnd: number): void => {
    const bs = b.slice(bi, bEnd);
    const ms = m.slice(mi, mEnd);
    const ts = t.slice(ti, tEnd);
    if (ms.length === 0 && ts.length === 0 && bs.length === 0) return;
    if (same(ms, ts)) chunks.push({ kind: 'stable', lines: ms });
    else if (same(ms, bs)) chunks.push({ kind: 'theirs', lines: ts });
    else if (same(ts, bs)) chunks.push({ kind: 'mine', lines: ms });
    else chunks.push({ kind: 'conflict', base: bs, mine: ms, theirs: ts });
  };

  while (bi < b.length) {
    // 양쪽 모두에 살아남은 줄이 안정점이다
    if (toMine[bi] === -1 || toTheirs[bi] === -1) {
      let k = bi;
      while (k < b.length && (toMine[k] === -1 || toTheirs[k] === -1)) k++;
      const mEnd = k < b.length ? toMine[k]! : m.length;
      const tEnd = k < b.length ? toTheirs[k]! : t.length;
      flushUnstable(k, mEnd, tEnd);
      bi = k;
      mi = mEnd;
      ti = tEnd;
      continue;
    }
    // 안정점인데 앞쪽에 한쪽만 끼워 넣은 줄이 있다
    if (toMine[bi]! > mi || toTheirs[bi]! > ti) {
      flushUnstable(bi, toMine[bi]!, toTheirs[bi]!);
      mi = toMine[bi]!;
      ti = toTheirs[bi]!;
      continue;
    }
    const run: string[] = [];
    while (bi < b.length && toMine[bi] === mi && toTheirs[bi] === ti) {
      run.push(b[bi]!);
      bi++;
      mi++;
      ti++;
    }
    if (run.length) chunks.push({ kind: 'stable', lines: run });
    else break; // 대응이 어긋났다 — 다음 회전에서 불안정 구간으로 처리된다
  }
  flushUnstable(b.length, m.length, t.length);

  const merged = squash(chunks);
  const conflicts = merged.filter((c) => c.kind === 'conflict').length;
  return { chunks: merged, conflicts, clean: conflicts === 0, text: render(merged, endsNl(mine, theirs)) };
}

/** 이어진 같은 종류의 구간을 하나로 합친다. 사람이 읽는 화면의 잡음을 줄인다. */
function squash(chunks: readonly MergeChunk[]): MergeChunk[] {
  const out: MergeChunk[] = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    if (c.kind !== 'conflict' && prev && prev.kind === c.kind) {
      prev.lines = [...prev.lines, ...c.lines];
      continue;
    }
    out.push(c.kind === 'conflict' ? { ...c } : { kind: c.kind, lines: [...c.lines] });
  }
  return out.filter((c) => c.kind === 'conflict' || c.lines.length > 0);
}

function endsNl(mine: string, theirs: string): boolean {
  return mine.endsWith('\n') || theirs.endsWith('\n');
}

function render(chunks: readonly MergeChunk[], trailing: boolean): string {
  const out: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'conflict') {
      out.push(MARK_MINE, ...c.mine, MARK_BASE, ...c.base, MARK_SPLIT, ...c.theirs, MARK_THEIRS);
    } else out.push(...c.lines);
  }
  if (out.length === 0) return '';
  return out.join('\n') + (trailing ? '\n' : '');
}

/** 병합 결과에 충돌 표시가 남아 있는가. 사람이 지우지 않고 저장하는 것을 막는다. */
export function hasMarkers(text: string): boolean {
  return text.split('\n').some((l) => l === MARK_MINE || l === MARK_BASE || l === MARK_SPLIT || l === MARK_THEIRS);
}
