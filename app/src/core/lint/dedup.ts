// 엔티티 중복 후보. M0 §4 실측에서 나온 파라미터를 그대로 쓴다.
//
// ★ 차용한 값 두 개가 한국어에서 틀렸다 (M0 §4.1·4.3):
//   - graphify 의 "글자당 2.5비트" 엔트로피 게이트는 한국어에서 뚫린다 → 길이 하한을 함께 본다
//   - graphify 의 Jaro-Winkler 임계 0.92 는 한국어에서 오병합 3건 → 0.96 이 필요하다
//   - 한글 자모 분해는 오히려 오병합을 늘린다 → 쓰지 않는다
//
// 위키에서 오병합은 복구가 어렵다. **오병합 0 을 절대 조건**으로 두고 재현율을 최대화했다.
// 병합은 자동으로 하지 않는다 — 후보만 내고 사람이 diff 로 승인한다.

const LEGAL = /(주식회사|㈜|\(주\)|\(유\)|유한회사|Inc\.?|Corp\.?|Co\.,?\s*Ltd\.?|LLC|Ltd\.?|GmbH)/gi;
const JOSA =
  /(으로부터|에게서|이라고|라고|으로서|로서|으로|에서|에게|과의|와의|이라|라는|이는|은|는|이|가|을|를|의|와|과|도|만|에|로)$/;

/** M0 §4.3 — 0.92 는 한국어에서 오병합 3건. 0.96 이 오병합 0. */
export const SIMILARITY_THRESHOLD = 0.96;
/** M0 §4.1 — 엔트로피 단독으로는 한국어에서 짧은 약어가 통과한다. 길이 하한이 필요하다. */
export const MIN_LABEL_LEN = 3;
export const MIN_ENTROPY = 1.0;

export interface DedupCandidate {
  a: string;
  b: string;
  score: number;
  /** 같은 커뮤니티인가. 사람에게 보여줄 참고 정보이지 판정 근거가 아니다 (아래 주석) */
  sameCommunity: boolean;
}

const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(LEGAL, '')
    .replace(/[()[\]{}·.,'"-]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();

const stripJosa = (s: string): string => {
  const t = s.replace(JOSA, '');
  return t.length >= 2 ? t : s;
};

export const normalizeLabel = (s: string): string => stripJosa(norm(s));

export function entropyPerChar(s: string): number {
  if (!s.length) return 0;
  const count = new Map<string, number>();
  for (const ch of s) count.set(ch, (count.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of count.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 짧고 모호한 이름(AI · DB · PM · 팀)을 자동 병합 대상에서 뺀다. */
export function passesGate(label: string): boolean {
  const k = normalizeLabel(label);
  return [...k].length >= MIN_LABEL_LEN && entropyPerChar(k) >= MIN_ENTROPY;
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const ma = new Array<boolean>(a.length).fill(false);
  const mb = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - win); j < Math.min(b.length, i + win + 1); j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = true;
      mb[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (m / a.length + m / b.length + (m - t / 2) / m) / 3;
}

export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  let l = 0;
  while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

/**
 * 중복 후보를 찾는다.
 *
 * ★ 같은 커뮤니티일 때 점수를 올리는 가중치를 넣었다가 뺐다. 실측하니 오병합이 생긴다:
 *   `구매팀` vs `구매팀장` 이 0.942 인데 +0.02 를 더하면 0.962 로 임계를 넘는다.
 *   커뮤니티 일치는 표시만 하고 판정에는 쓰지 않는다.
 *
 * MinHash/LSH 는 아직 넣지 않았다 — 위키가 수백 페이지를 넘을 때 도입한다.
 * 그 전에는 후보쌍이 적어 O(n²) 이 문제되지 않는다.
 */
export function findDuplicates(
  labels: readonly { id: string; label: string; aliases?: readonly string[] }[],
  sameCommunity?: (a: string, b: string) => boolean,
): DedupCandidate[] {
  const usable = labels.filter((x) => passesGate(x.label));
  const out: DedupCandidate[] = [];

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const x = usable[i]!;
      const y = usable[j]!;

      // 이미 별칭으로 연결돼 있으면 후보가 아니다
      const known = new Set([...(x.aliases ?? []), ...(y.aliases ?? [])].map(normalizeLabel));
      if (known.has(normalizeLabel(y.label)) || known.has(normalizeLabel(x.label))) continue;

      const kx = normalizeLabel(x.label);
      const ky = normalizeLabel(y.label);
      const score = kx === ky ? 1 : jaroWinkler(kx, ky);
      if (score >= SIMILARITY_THRESHOLD) {
        out.push({ a: x.id, b: y.id, score, sameCommunity: sameCommunity?.(x.id, y.id) ?? false });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
