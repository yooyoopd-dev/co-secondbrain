// HTTP 표면. HUB.md §4
//
// 프레임워크를 쓰지 않는다. 경로가 열 개 남짓이라 직접 가르는 편이 짧고, 사내 오프라인
// 설치에서 의존성 하나가 곧 배포 비용이다.
//
// 인터넷에 노출하지 않는다. 사내망 IP 에만 바인딩하고 방화벽으로 대역을 막는다.
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { allows, identify, roleOf, sameSecret, hashToken, mintToken } from './auth.ts';
import { blobMeta, blobPath, putBlob } from './blobs.ts';
import { changes, deletePage, getPage, putPage } from './store.ts';
import type { Role } from './db.ts';

export interface HubConfig {
  db: DatabaseSync;
  blobDir: string;
  /** 관리 API 의 부트스트랩 열쇠. 첫 토큰을 만들려면 이게 있어야 한다 */
  adminKey: string;
  now?: () => string;
}

/** JSON 본문 상한. 페이지 하나가 이보다 크면 위키가 아니라 다른 문제다. */
const MAX_JSON = 4 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_JSON) throw new Error('본문이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function createHub(cfg: HubConfig) {
  const { db, blobDir, adminKey } = cfg;
  const now = cfg.now ?? (() => new Date().toISOString());

  /** 공간 접근을 한 곳에서 판정한다. 여기 없는 경로는 공간에 못 닿는다. */
  const gate = (req: IncomingMessage, spaceId: string, need: Role) => {
    const who = identify(db, req.headers.authorization, now());
    if (!who) return { err: 401 as const, msg: '토큰이 없거나 유효하지 않습니다' };
    const role = roleOf(db, spaceId, who.userId);
    if (!allows(role, need)) return { err: 403 as const, msg: '권한이 없습니다' };
    return { who };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://hub');
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (url.pathname === '/v1/health') return json(res, 200, { ok: true, at: now() });

    /* ---------------- 관리 ---------------- */
    if (seg[0] === 'v1' && seg[1] === 'admin') {
      const key = req.headers['x-admin-key'];
      if (typeof key !== 'string' || !sameSecret(key, adminKey)) return json(res, 401, { error: '관리 열쇠가 틀립니다' });
      const body = await readJson(req);

      if (method === 'POST' && seg[2] === 'spaces') {
        const id = str(body['id']);
        const title = str(body['title']);
        if (!id || !title) return json(res, 400, { error: 'id 와 title 이 필요합니다' });
        db.prepare('INSERT OR REPLACE INTO spaces (id, title, created_at) VALUES (?,?,?)').run(id, title, now());
        return json(res, 200, { id, title });
      }
      if (method === 'POST' && seg[2] === 'members') {
        const spaceId = str(body['spaceId']);
        const userId = str(body['userId']);
        const role = str(body['role']);
        if (!spaceId || !userId || !role || !['admin', 'writer', 'reader'].includes(role)) {
          return json(res, 400, { error: 'spaceId · userId · role(admin|writer|reader) 이 필요합니다' });
        }
        db.prepare('INSERT OR REPLACE INTO members (space_id, user_id, role) VALUES (?,?,?)').run(spaceId, userId, role);
        return json(res, 200, { spaceId, userId, role });
      }
      if (method === 'POST' && seg[2] === 'tokens' && seg.length === 3) {
        const userId = str(body['userId']);
        if (!userId) return json(res, 400, { error: 'userId 가 필요합니다' });
        const token = mintToken();
        db.prepare('INSERT INTO tokens (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
          hashToken(token), userId, now(), str(body['expiresAt']),
        );
        // 평문은 여기서 한 번만 나온다. 서버는 해시만 갖는다
        return json(res, 200, { userId, token });
      }
      if (method === 'POST' && seg[2] === 'tokens' && seg[4] === 'revoke') {
        db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(str(seg[3] ?? '') ?? '');
        return json(res, 200, { revoked: true });
      }
      return json(res, 404, { error: '없는 관리 경로입니다' });
    }

    /* ---------------- 공간 목록 ---------------- */
    if (method === 'GET' && url.pathname === '/v1/spaces') {
      const who = identify(db, req.headers.authorization, now());
      if (!who) return json(res, 401, { error: '토큰이 없거나 유효하지 않습니다' });
      const rows = db
        .prepare('SELECT s.id, s.title, m.role FROM spaces s JOIN members m ON m.space_id = s.id WHERE m.user_id = ? ORDER BY s.id')
        .all(who.userId);
      return json(res, 200, { spaces: rows });
    }

    if (seg[0] !== 'v1' || seg[1] !== 'spaces' || !seg[2]) return json(res, 404, { error: '없는 경로입니다' });
    const spaceId = decodeURIComponent(seg[2]);

    /* ---------------- 변경 목록 ---------------- */
    if (method === 'GET' && seg[3] === 'changes') {
      const g = gate(req, spaceId, 'reader');
      if ('err' in g) return json(res, g.err, { error: g.msg });
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '500') || 500));
      return json(res, 200, changes(db, spaceId, since, limit));
    }

    /* ---------------- 페이지 ---------------- */
    if (seg[3] === 'pages' && seg[4]) {
      const pageId = decodeURIComponent(seg[4]);

      if (method === 'GET') {
        const g = gate(req, spaceId, 'reader');
        if ('err' in g) return json(res, g.err, { error: g.msg });
        const v = url.searchParams.get('version');
        const page = getPage(db, spaceId, pageId, v === null ? undefined : Number(v));
        if (!page || (page.deleted && v === null)) return json(res, 404, { error: '없는 페이지입니다' });
        return json(res, 200, {
          pageId, path: page.path, version: page.version, hash: page.hash,
          content: page.content, updatedBy: page.updated_by, updatedAt: page.updated_at, deleted: !!page.deleted,
        });
      }

      if (method === 'PUT') {
        const g = gate(req, spaceId, 'writer');
        if ('err' in g) return json(res, g.err, { error: g.msg });
        const body = await readJson(req);
        const path = str(body['path']);
        const content = typeof body['content'] === 'string' ? (body['content'] as string) : null;
        if (!path || content === null) return json(res, 400, { error: 'path 와 content 가 필요합니다' });

        const ifMatch = req.headers['if-match'];
        const ifNone = req.headers['if-none-match'];
        let baseVersion: number | null;
        if (ifNone === '*') baseVersion = null;
        else if (typeof ifMatch === 'string' && /^\d+$/.test(ifMatch)) baseVersion = Number(ifMatch);
        else return json(res, 428, { error: 'If-Match: <version> 또는 If-None-Match: * 가 필요합니다' });

        const r = putPage(db, spaceId, pageId, { path, content, baseVersion }, g.who.userId, now());
        return r.ok ? json(res, 200, { version: r.version, hash: r.hash }) : json(res, 409, r.conflict);
      }

      if (method === 'DELETE') {
        const g = gate(req, spaceId, 'writer');
        if ('err' in g) return json(res, g.err, { error: g.msg });
        const ifMatch = req.headers['if-match'];
        if (typeof ifMatch !== 'string' || !/^\d+$/.test(ifMatch)) {
          return json(res, 428, { error: 'If-Match: <version> 이 필요합니다' });
        }
        const r = deletePage(db, spaceId, pageId, Number(ifMatch), g.who.userId, now());
        return r.ok ? json(res, 200, { version: r.version }) : json(res, 409, r.conflict);
      }
    }

    /* ---------------- blob ---------------- */
    if (seg[3] === 'blobs') {
      if (method === 'POST' && !seg[4]) {
        const g = gate(req, spaceId, 'writer');
        if ('err' in g) return json(res, g.err, { error: g.msg });
        const filename = url.searchParams.get('filename');
        if (!filename) return json(res, 400, { error: 'filename 질의 문자열이 필요합니다' });
        const r = await putBlob(db, blobDir, spaceId, { filename, mime: url.searchParams.get('mime') }, req, g.who.userId, now());
        return json(res, 200, r);
      }
      if (seg[4] && (method === 'GET' || method === 'HEAD')) {
        const g = gate(req, spaceId, 'reader');
        if ('err' in g) return json(res, g.err, { error: g.msg });
        const meta = blobMeta(db, spaceId, seg[4]);
        if (!meta) return json(res, 404, { error: '없는 파일입니다' });
        const file = blobPath(blobDir, seg[4]);
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-length': meta.bytes, 'accept-ranges': 'bytes' });
          res.end();
          return;
        }
        // Range — 200MB 짜리를 통째로 다시 받지 않게 한다
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Number(range[2]) : meta.bytes - 1;
          if (start >= meta.bytes || end < start) {
            res.writeHead(416, { 'content-range': `bytes */${meta.bytes}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            'content-range': `bytes ${start}-${end}/${meta.bytes}`,
            'content-length': end - start + 1,
            'accept-ranges': 'bytes',
          });
          return void createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'content-length': meta.bytes, 'accept-ranges': 'bytes' });
        return void createReadStream(file).pipe(res);
      }
    }

    return json(res, 404, { error: '없는 경로입니다' });
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
}
