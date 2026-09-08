// Ollama HTTP 클라이언트. 로컬 모델 질의 경로가 쓰는 유일한 바깥 통로다.
//
// **공급자(`AgentCli`)가 아니다.** 그쪽은 프로세스를 띄우고 모델이 MCP 로 위키를
// 당겨 간다. 여기는 앱이 찾아서 프롬프트에 넣고 한 번 부른다 (docs/LOCAL-LLM.md §2.2).
// 그래서 `PROVIDERS` 목록에도 라우터에도 안 들어간다 — 예산을 쓰지 않기 때문이다.
//
// `fetch` 를 주입받는다. 테스트가 가짜 서버를 물릴 자리이고, 실행 중에는 전역 fetch 다.

/** 사내 PC 기본값. 설정에서 바꿀 수 있다 */
export const DEFAULT_LOCAL = {
  host: 'http://127.0.0.1:11434',
  chatModel: 'qwen2.5',
  embedModel: 'bge-m3',
} as const;

export interface LocalConfig {
  host: string;
  chatModel: string;
  embedModel: string;
}

/** 모델 이름은 `qwen2.5:7b` 처럼 태그가 붙어 온다. 앞부분만 맞으면 같은 모델로 본다 */
export function pickModel(installed: readonly string[], want: string): string | null {
  return installed.find((n) => n === want || n.startsWith(`${want}:`)) ?? null;
}

export interface LocalStatus {
  ok: boolean;
  /** 못 붙었거나 모델이 없으면 사람이 읽을 사유 */
  error: string | null;
  /** 실제로 쓸 이름. 태그까지 붙은 것 */
  chat: string | null;
  embed: string | null;
}

export class Ollama {
  readonly #cfg: LocalConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(cfg: LocalConfig, f: typeof globalThis.fetch = globalThis.fetch) {
    this.#cfg = cfg;
    this.#fetch = f;
  }

  get config(): LocalConfig {
    return this.#cfg;
  }

  /**
   * 붙었는가, 두 모델이 다 있는가. **켤 때마다 안 부른다** — 사람이 설정을 열거나
   * 로컬로 답하려 할 때만 본다. Ollama 가 꺼져 있는 것은 오류가 아니라 상태다.
   */
  async status(signal?: AbortSignal): Promise<LocalStatus> {
    let names: string[];
    try {
      const r = await this.#fetch(`${this.#cfg.host}/api/tags`, {
        signal: signal ?? AbortSignal.timeout(5000),
      });
      if (!r.ok) return { ok: false, error: `Ollama 가 HTTP ${r.status} 를 냈습니다`, chat: null, embed: null };
      const j = (await r.json()) as { models?: { name: string }[] };
      names = (j.models ?? []).map((m) => m.name);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Ollama 에 못 붙었습니다 (${this.#cfg.host}). ${why}`, chat: null, embed: null };
    }

    const chat = pickModel(names, this.#cfg.chatModel);
    const embed = pickModel(names, this.#cfg.embedModel);
    const missing = [chat ? null : this.#cfg.chatModel, embed ? null : this.#cfg.embedModel].filter(
      (x): x is string => x !== null,
    );
    if (missing.length) {
      return { ok: false, error: `모델이 없습니다: ${missing.join(' · ')}. \`ollama pull\` 로 받으십시오`, chat, embed };
    }
    return { ok: true, error: null, chat, embed };
  }

  /**
   * 청크 여러 개를 한 번에 임베딩한다. 길이가 입력과 다르면 실패로 본다 —
   * 짝이 어긋난 벡터는 엉뚱한 청크를 가리키고, 그건 조용한 오답이 된다.
   */
  async embed(model: string, input: readonly string[], signal?: AbortSignal): Promise<{ ok: true; vectors: Float32Array[] } | { ok: false; error: string }> {
    try {
      const r = await this.#fetch(`${this.#cfg.host}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: signal ?? AbortSignal.timeout(300_000),
      });
      if (!r.ok) return { ok: false, error: `임베딩이 HTTP ${r.status} 를 냈습니다` };
      const j = (await r.json()) as { embeddings?: number[][] };
      const v = j.embeddings ?? [];
      if (v.length !== input.length) return { ok: false, error: `벡터 수가 안 맞습니다 (${v.length} / ${input.length})` };
      return { ok: true, vectors: v.map((x) => Float32Array.from(x)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 한 번 부르고 끝낸다. 도구 호출 반복이 없다.
   *
   * `format` 에 JSON Schema 를 그대로 넘긴다. Gemini CLI 와 달리 **서버가 형식을 강제**하므로
   * 재요청 회차를 두지 않는다 (docs/LOCAL-LLM.md §4).
   */
  async chat(model: string, prompt: string, schema: unknown, signal?: AbortSignal): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    try {
      const r = await this.#fetch(`${this.#cfg.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, format: schema, messages: [{ role: 'user', content: prompt }] }),
        signal: signal ?? AbortSignal.timeout(600_000),
      });
      if (!r.ok) return { ok: false, error: `모델이 HTTP ${r.status} 를 냈습니다` };
      const j = (await r.json()) as { message?: { content?: string } };
      const raw = j.message?.content ?? '';
      if (!raw.trim()) return { ok: false, error: '모델이 빈 답을 냈습니다' };
      try {
        return { ok: true, data: JSON.parse(raw) };
      } catch {
        return { ok: false, error: 'JSON 이 아닌 답이 왔습니다' };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
