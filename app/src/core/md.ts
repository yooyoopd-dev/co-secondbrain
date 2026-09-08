// 마크다운을 블록 트리로 바꾼다. 그리는 것은 렌더러가 한다.
//
// **HTML 을 HTML 로 그리지 않는다.** 원본 md 에는 변환기가 남긴 `<td>` · `<br>` 같은
// 조각이 섞여 있고, 그것을 그대로 화면에 넣으면 주입 통로가 된다. 여기서는 태그를
// 글자로 바꾸거나 지운다. 원본이 궁금하면 화면의 [원본] 토글로 본다.
//
// 지원하는 것만 적는다 — 제목·문단·목록·인용·코드·구분선·파이프 표, 그리고 인라인의
// 굵게·기울임·코드·링크·위키링크. **각주 인용(`[^src-a#p1]`)은 글자로 둔다.**
// 화면이 따로 칩으로 그리기 때문에 여기서 링크로 바꾸면 두 번 나온다.
//
// 라이브러리를 안 쓴다. 사내망에서 새 패키지를 늘리는 비용이 여기 필요한 문법보다 크다
// (icons.tsx 와 같은 이유).

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'link'; v: Inline[]; href: string };

export type Block =
  | { t: 'h'; level: number; v: Inline[] }
  | { t: 'p'; v: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; v: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

/** 이름 있는 엔티티만 푼다. 숫자 참조는 아래에서 따로 본다. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML 조각을 글자로 내린다.
 *
 * 표 태그는 그냥 지우면 칸이 다 붙어 버린다. 칸 끝은 가운뎃점으로, 줄 끝은 줄바꿈으로
 * 바꿔 읽을 수 있게 남긴다. 변환기가 만든 md 에서 실제로 겪은 모양이다.
 */
export function stripHtml(s: string): string {
  const out = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' · ')
    .replace(/<[^<>]*>/g, '');
  return decodeEntities(out)
    .replace(/[ \t]*·[ \t]*(\n|$)/g, '$1') // 줄 끝에 남은 칸 구분자는 지운다
    .replace(/[ \t]+\n/g, '\n');
}

/** 이 줄이 파이프 표의 구분선인가 (`|---|:--:|`) */
function isDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

const FENCE = /^\s*(```+|~~~+)\s*(\S*)/;

/**
 * 블록으로 자른다. 앞의 YAML front-matter 는 코드 블록으로 남긴다 — 위키 페이지를
 * 이 뷰로 볼 때 머리말을 감추면 무엇을 보고 있는지 알 수 없다.
 */
export function parseMarkdown(src: string): Block[] {
  const lines = stripHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: Block[] = [];
  let i = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (end > 0) {
      out.push({ t: 'code', lang: 'yaml', v: lines.slice(1, end).join('\n') });
      i = end + 1;
    }
  }

  let para: string[] = [];
  const flush = () => {
    if (para.length === 0) return;
    out.push({ t: 'p', v: parseInline(para.join('\n')) });
    para = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1]!.slice(0, 3);
      const body: string[] = [];
      i++;
      for (; i < lines.length && !lines[i]!.trimStart().startsWith(mark); i++) body.push(lines[i]!);
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ t: 'hr' });
      continue;
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: 'h', level: h[1]!.length, v: parseInline(h[2]!.trim()) });
      continue;
    }

    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const body = [q[1]!];
      while (i + 1 < lines.length && /^\s{0,3}>\s?/.test(lines[i + 1]!)) {
        body.push(lines[++i]!.replace(/^\s{0,3}>\s?/, ''));
      }
      out.push({ t: 'quote', v: parseInline(body.join('\n')) });
      continue;
    }

    const li = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const items = [li[2]!];
      while (i + 1 < lines.length) {
        const next = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!next || /\d/.test(next[1]!) !== ordered) break;
        items.push(next[2]!);
        i++;
      }
      out.push({ t: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    // 파이프 표는 머리 줄 다음에 구분선이 와야 표다. 구분선이 없으면 그냥 문단이다.
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flush();
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      for (; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== ''; i++) {
        rows.push(cells(lines[i]!).map(parseInline));
      }
      i--;
      out.push({ t: 'table', head, rows });
      continue;
    }

    para.push(line);
  }
  flush();
  return out;
}

/** 인라인 표기를 자른다. 코드가 가장 세다 — 코드 안의 별표는 강조가 아니다. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const text = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };

  for (let i = 0; i < src.length; i++) {
    const rest = src.slice(i);

    const code = /^(`+)([\s\S]*?)\1/.exec(rest);
    if (code) {
      text();
      out.push({ t: 'code', v: code[2]!.trim() });
      i += code[0].length - 1;
      continue;
    }

    // 각주 인용은 손대지 않는다. 화면이 칩으로 따로 그린다.
    const foot = /^\[\^[^\]]+\]/.exec(rest);
    if (foot) {
      buf += foot[0];
      i += foot[0].length - 1;
      continue;
    }

    const wiki = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(rest);
    if (wiki) {
      text();
      out.push({ t: 'link', v: [{ t: 'text', v: wiki[2] ?? wiki[1]! }], href: wiki[1]! });
      i += wiki[0].length - 1;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest);
    if (link) {
      text();
      out.push({ t: 'link', v: parseInline(link[1]!), href: link[2]! });
      i += link[0].length - 1;
      continue;
    }

    const strong = /^(\*\*|__)([\s\S]+?)\1/.exec(rest);
    if (strong) {
      text();
      out.push({ t: 'strong', v: parseInline(strong[2]!) });
      i += strong[0].length - 1;
      continue;
    }

    const em = /^(\*|_)(?!\s)([\s\S]+?)\1/.exec(rest);
    if (em) {
      text();
      out.push({ t: 'em', v: parseInline(em[2]!) });
      i += em[0].length - 1;
      continue;
    }

    buf += src[i];
  }
  text();
  return out;
}

/** 검색 조각처럼 짧은 글에 쓴다. 블록을 안 만들고 인라인만 푼다. */
export function parseSnippet(src: string): Inline[] {
  return parseInline(stripHtml(src).replace(/\n+/g, ' ').trim());
}
