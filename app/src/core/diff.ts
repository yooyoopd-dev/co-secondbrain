// 줄 단위 diff. 사람이 승인하는 화면의 재료다. DESIGN-SYSTEM.md "Diff 검토 카드"
//
// 라이브러리를 쓰지 않는다. 필요한 건 LCS 하나뿐이고, 오프라인 사내 설치라
// 의존성 하나가 곧 배포 비용이다.
export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * 이 줄 수를 넘으면 LCS 표(줄수²)가 커져 UI 가 멈춘다. 그때는 전면 교체로 보여준다.
 * 위키 페이지는 보통 수십 줄이라 실사용에서 걸릴 일은 없다.
 */
export const MAX_LINES = 2000;

/** 파일 끝의 줄바꿈 하나는 줄로 세지 않는다 — 안 그러면 모든 diff 끝에 빈 줄이 붙는다. */
function lines(s: string): string[] {
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }

  const m = a.length;
  const n = b.length;
  const w = n + 1;
  const lcs = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++]! });
  while (j < n) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

/** 카드 머리에 띄우는 `+12 −3`. */
export function diffStat(d: readonly DiffLine[]): { added: number; deleted: number } {
  return {
    added: d.filter((l) => l.kind === 'add').length,
    deleted: d.filter((l) => l.kind === 'del').length,
  };
}

export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * 좌: 현재 / 우: 제안 두 열로 짝지운다 (DESIGN-SYSTEM.md "Diff 검토 카드").
 * 연속한 삭제와 추가는 같은 줄에 마주 놓는다 — 한 줄을 고친 것이 두 줄로 흩어지면
 * 사람이 무엇이 바뀌었는지 못 읽는다.
 */
export function sideBySide(d: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < d.length) {
    if (d[i]!.kind === 'same') {
      rows.push({ left: d[i]!, right: d[i]! });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < d.length && d[i]!.kind === 'del') dels.push(d[i++]!);
    while (i < d.length && d[i]!.kind === 'add') adds.push(d[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}
