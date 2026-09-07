// 허브 HTTP 클라이언트. HUB.md §4 의 경로를 그대로 옮긴 것.
//
// 이 파일은 판단하지 않는다. 상태 코드를 결과 타입으로 바꿔 줄 뿐이고,
// 무엇을 할지는 engine.ts 가 정한다.
export interface HubAuth {
  /** `http://co-hub.사내:8080` — 끝 슬래시는 있어도 된다 */
  url: string;
  token: string;
}

export interface RemotePage {
  pageId: string;
  path: string;
  version: number;
  hash: string;
  content: string;
  updatedBy: string;
  updatedAt: string;
  deleted: boolean;
}

/** 409 가 돌려주는 병합 재료. hub/src/store.ts 의 Conflict 와 같은 모양 */
export interface RemoteConflict {
  serverVersion: number;
  serverContent: string;
  baseContent: string | null;
}

export type WriteOutcome =
  | { ok: true; version: number; hash: string | null }
  | { ok: false; conflict: RemoteConflict };

export interface SpaceRow {
  id: string;
  title: string;
  role: 'admin' | 'writer' | 'reader';
}

export interface ChangeEvent {
  seq: number;
  space_id: string;
  kind: string;
  page_id: string | null;
  ref: string | null;
  title: string | null;
  actor: string;
  at: string;
}

export interface HubClient {
  spaces(): Promise<SpaceRow[]>;
  changes(spaceId: string, since: number, limit?: number): Promise<{ events: ChangeEvent[]; nextSeq: number; hasMore: boolean }>;
  /** 없거나 지워진 페이지는 null */
  getPage(spaceId: string, pageId: string): Promise<RemotePage | null>;
  putPage(spaceId: string, pageId: string, input: { path: string; content: string; baseVersion: number | null }): Promise<WriteOutcome>;
  deletePage(spaceId: string, pageId: string, baseVersion: number): Promise<WriteOutcome>;
}

export class HubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 허브가 안 뜬 것과 응답이 이상한 것을 구분한다 — 오프라인 큐 판정이 여기 달렸다. */
export class HubOffline extends Error {}

type Fetch = typeof globalThis.fetch;

export function hubClient(auth: HubAuth, fetchImpl: Fetch = globalThis.fetch): HubClient {
  const base = auth.url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${auth.token}` };

  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
      });
    } catch (e) {
      throw new HubOffline(`허브에 닿지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const readJson = async (res: Response): Promise<Record<string, unknown>> => {
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HubError(res.status, `허브 응답이 JSON 이 아닙니다: ${text.slice(0, 120)}`);
    }
  };

  const ok = async (res: Response): Promise<Record<string, unknown>> => {
    const body = await readJson(res);
    if (!res.ok) throw new HubError(res.status, String(body['error'] ?? res.statusText));
    return body;
  };

  const write = async (path: string, init: RequestInit): Promise<WriteOutcome> => {
    const res = await call(path, init);
    const body = await readJson(res);
    if (res.status === 409) return { ok: false, conflict: body as unknown as RemoteConflict };
    if (!res.ok) throw new HubError(res.status, String(body['error'] ?? res.statusText));
    return { ok: true, version: Number(body['version']), hash: (body['hash'] as string | undefined) ?? null };
  };

  const enc = encodeURIComponent;

  return {
    async spaces() {
      return (await ok(await call('/v1/spaces')))['spaces'] as SpaceRow[];
    },

    async changes(spaceId, since, limit = 500) {
      const body = await ok(await call(`/v1/spaces/${enc(spaceId)}/changes?since=${since}&limit=${limit}`));
      return body as unknown as { events: ChangeEvent[]; nextSeq: number; hasMore: boolean };
    },

    async getPage(spaceId, pageId) {
      const res = await call(`/v1/spaces/${enc(spaceId)}/pages/${enc(pageId)}`);
      if (res.status === 404) {
        await res.text();
        return null;
      }
      return (await ok(res)) as unknown as RemotePage;
    },

    async putPage(spaceId, pageId, input) {
      return write(`/v1/spaces/${enc(spaceId)}/pages/${enc(pageId)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(input.baseVersion === null ? { 'if-none-match': '*' } : { 'if-match': String(input.baseVersion) }),
        },
        body: JSON.stringify({ path: input.path, content: input.content }),
      });
    },

    async deletePage(spaceId, pageId, baseVersion) {
      return write(`/v1/spaces/${enc(spaceId)}/pages/${enc(pageId)}`, {
        method: 'DELETE',
        headers: { 'if-match': String(baseVersion) },
      });
    },
  };
}
