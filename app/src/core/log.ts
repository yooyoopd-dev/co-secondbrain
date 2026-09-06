// 오류 기록. 화면에서 통째로 복사해 붙여 넣을 수 있어야 한다.
//
// **파일명과 토큰은 지우고 보관한다.** 이 로그의 목적지는 클립보드이고, 사내 문서를
// 다루는 앱에서 클립보드는 반출 경로다. 그래서 경로는 `<파일 12자>.pptx` 처럼
// 확장자와 글자 수만 남긴다 — 어느 문서가 실패했는지는 쓴 사람이 알아보고,
// 받는 쪽은 이름을 모른다. 지출 수치를 사람이 옮겨 적는 규칙(ROADMAP.md §3)과 같은 태도다.
//
// 버퍼는 메모리에만 있다. 디스크에 로그 파일을 남기지 않는다 — 사람이 [파일로 저장]을
// 눌렀을 때만 저장 대화상자를 거쳐 한 번 쓰인다.

export type LogLevel = 'error' | 'warn' | 'info';

export interface LogEntry {
  /** ISO 8601. 초까지만 쓴다 */
  at: string;
  level: LogLevel;
  /** 어디서 났는가. `ipc:search` `renderer` `main` 같은 짧은 이름 */
  scope: string;
  message: string;
  /** 스택이나 부가 정보. 이미 비식별 처리된 문자열이다 */
  detail?: string;
}

/** 긴 무작위 문자열은 토큰으로 본다. 허브 토큰이 오류 메시지에 섞여 나온 적이 있다 */
const TOKENISH = /\b[A-Za-z0-9_\-]{24,}\b/g;
/** `token=...` `Authorization: Bearer ...` 처럼 이름이 붙은 것. `Bearer` 까지 삼켜야
 *  값이 남지 않는다 — 값만 잡으면 `Authorization: [가림] abc123` 이 된다 */
const NAMED_SECRET = /\b(token|authorization|password|secret|apikey|api[_-]?key)\b\s*[:=]?\s*(?:bearer\s+|token\s+)?[^\s"',;)]+/gi;
/** 이름 없이 나온 `Bearer xxx` */
const BEARER = /\bbearer\s+[^\s"',;)]+/gi;
/** 파일명 한 덩어리. 공백을 두 칸까지 받는다 — "킥오프 발표.pptx" 를 통째로 잡아야 한다.
 *  대신 앞의 낱말 두 개까지 같이 지워질 수 있다. 남기는 쪽보다 지우는 쪽으로 틀린다. */
const NAME = String.raw`[^\s\\/:*?"<>|]+(?: [^\s\\/:*?"<>|]+){0,2}`;
/** Windows 드라이브·UNC·POSIX 절대 경로.
 *  `http://` 의 `p:` 와 `//` 가 드라이브·POSIX 규칙에 걸리지 않게 앞을 막는다 */
const ABS_PATH = new RegExp(
  String.raw`(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|(?<![\w.:/])\/(?=[\w.]))` +
    String.raw`(?:${NAME}[\\/])*(?:${NAME})?`,
  'g',
);
/** 경로 없이 이름만 나온 파일. 확장자는 core/types.ts 가 받는 것들이다 */
const BARE_FILE = new RegExp(String.raw`${NAME}\.(eml|msg|md|txt|docx|xlsx|pptx|pdf|vtt|srt|csv|json)\b`, 'gi');
/** URL 은 출처(scheme+host+port)만 남긴다. 경로에 페이지 이름이 들어간다 */
const URL_PATH = /(https?:\/\/[^\s/]+)(\/[^\s"'<>)]*)/gi;

/** 파일 하나를 `<파일 n자>.ext` 로 줄인다. n 은 확장자를 뺀 이름의 코드 포인트 수 */
function maskFile(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `<파일 ${[...stem].length}자>${ext}`;
}

/**
 * 클립보드에 나가도 되는 형태로 바꾼다. 지우는 것은 토큰·경로·파일명·URL 경로 넷이다.
 * 순서가 중요하다 — 토큰을 먼저 지워야 경로 규칙이 토큰을 잘라 먹지 않는다.
 */
export function redact(text: string): string {
  let s = String(text);
  s = s.replace(NAMED_SECRET, (_m, key: string) => `${key}: [가림]`);
  s = s.replace(BEARER, 'Bearer [가림]');
  s = s.replace(URL_PATH, (_m, origin: string) => `${origin}/…`);
  s = s.replace(ABS_PATH, (m) => {
    const last = m.split(/[\\/]/).filter(Boolean).pop();
    return last ? `…/${maskFile(last)}` : '…';
  });
  s = s.replace(BARE_FILE, (m) => maskFile(m));
  s = s.replace(TOKENISH, '[가림]');
  return s;
}

/** Error 든 문자열이든 한 줄 메시지와 상세로 가른다 */
export function describe(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) {
    const stack = err.stack && err.stack !== `${err.name}: ${err.message}` ? err.stack : null;
    const message = `${err.name}: ${err.message}`;
    return stack === null ? { message } : { message, detail: stack };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

/** 최근 것만 들고 있는 고정 크기 버퍼. 오래된 것부터 버린다 */
export class LogBuffer {
  #entries: LogEntry[] = [];
  #errors = 0;
  #cap: number;

  constructor(cap = 500) {
    this.#cap = cap;
  }

  add(level: LogLevel, scope: string, message: string, detail?: string): LogEntry {
    const e: LogEntry = {
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      level,
      scope: redact(scope),
      message: redact(message),
      ...(detail === undefined ? {} : { detail: redact(detail) }),
    };
    this.#entries.push(e);
    if (level === 'error') this.#errors += 1;
    while (this.#entries.length > this.#cap) {
      const dropped = this.#entries.shift();
      if (dropped?.level === 'error') this.#errors -= 1;
    }
    return e;
  }

  /** 던져진 것을 그대로 받는다. 부르는 쪽이 Error 를 풀지 않아도 된다 */
  fail(scope: string, err: unknown): LogEntry {
    const { message, detail } = describe(err);
    return this.add('error', scope, message, detail);
  }

  entries(): LogEntry[] {
    return [...this.#entries];
  }

  /** 화면 배지에 쓰는 오류 건수 */
  errorCount(): number {
    return this.#errors;
  }

  clear(): void {
    this.#entries = [];
    this.#errors = 0;
  }
}

/** 클립보드에 넣을 본문. 붙여 넣은 사람이 읽을 수 있어야 한다 */
export function formatLog(entries: readonly LogEntry[], header: Record<string, string> = {}): string {
  const head = Object.entries(header).map(([k, v]) => `${k}: ${redact(v)}`);
  const body = entries.map((e) => {
    const line = `[${e.at}] ${e.level.toUpperCase().padEnd(5)} ${e.scope} — ${e.message}`;
    return e.detail ? `${line}\n${e.detail.replace(/^/gm, '    ')}` : line;
  });
  return [
    '# co-secondbrain 오류 기록',
    ...head,
    '파일명과 토큰은 지우고 적었습니다. 확장자와 글자 수만 남습니다.',
    '',
    ...(body.length > 0 ? body : ['(기록 없음)']),
    '',
  ].join('\n');
}
