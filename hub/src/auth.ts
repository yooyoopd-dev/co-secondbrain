// 토큰 인증. HUB.md §6
//
// **평문을 저장하지 않는다.** 발급할 때 한 번만 보여 주고 해시만 남긴다.
// 사내망 전용이라 인터넷 노출이 없지만, DB 가 새어도 토큰이 바로 쓰이지 않게 한다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Role } from './db.ts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 발급. 평문은 이 반환값에서만 볼 수 있다. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface Identity {
  userId: string;
}

/** 헤더의 Bearer 토큰을 사용자로 바꾼다. 만료·폐기를 여기서 본다. */
export function identify(db: DatabaseSync, header: string | undefined, now: string): Identity | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return null;
  const row = db
    .prepare('SELECT user_id, expires_at, revoked FROM tokens WHERE token_hash = ?')
    .get(hashToken(m[1]!.trim())) as { user_id: string; expires_at: string | null; revoked: number } | undefined;
  if (!row || row.revoked) return null;
  if (row.expires_at && row.expires_at <= now) return null;
  return { userId: row.user_id };
}

/** 상수 시간 비교. 관리자 키처럼 짧은 비밀에 쓴다. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

const RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2 };

export function roleOf(db: DatabaseSync, spaceId: string, userId: string): Role | null {
  const row = db.prepare('SELECT role FROM members WHERE space_id = ? AND user_id = ?').get(spaceId, userId) as
    | { role: Role }
    | undefined;
  return row?.role ?? null;
}

export function allows(role: Role | null, need: Role): boolean {
  return role !== null && RANK[role] >= RANK[need];
}
