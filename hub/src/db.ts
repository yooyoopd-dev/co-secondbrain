// 허브 스키마. HUB.md §3
//
// **허브는 멍청하다.** LLM 도 비즈니스 로직도 없다. 저장하고 버전을 세고 이벤트를 쌓는다.
// 서버가 죽어도 각자 로컬 미러로 계속 일한다.
//
// 런타임 의존성이 없다 — `node:sqlite` 와 `node:http` 만 쓴다. 사내 오프라인 설치에서
// 의존성 하나가 곧 배포 비용이다.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  space_id TEXT NOT NULL,
  page_id  TEXT NOT NULL,
  path     TEXT NOT NULL,
  version  INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  content  TEXT NOT NULL,
  deleted  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (space_id, page_id)
);

-- 3-way 병합의 base 와 되돌리기가 여기서 나온다. 마크다운이라 용량 부담이 없다
-- (원본 500건 프로젝트 실측 12.7MB, HUB.md §7).
CREATE TABLE IF NOT EXISTS page_versions (
  space_id TEXT NOT NULL, page_id TEXT NOT NULL, version INTEGER NOT NULL,
  hash TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  PRIMARY KEY (space_id, page_id, version)
);

CREATE TABLE IF NOT EXISTS blobs (
  space_id TEXT NOT NULL, sha256 TEXT NOT NULL,
  filename TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT,
  uploaded_at TEXT NOT NULL, uploaded_by TEXT NOT NULL,
  PRIMARY KEY (space_id, sha256)
);

-- 동기화 커서의 기준이자 log.md 의 정본
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  page_id TEXT, ref TEXT, title TEXT,
  actor TEXT NOT NULL, at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_space_seq ON events(space_id, seq);
`;

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export type Role = 'admin' | 'writer' | 'reader';

export interface PageRow {
  space_id: string;
  page_id: string;
  path: string;
  version: number;
  hash: string;
  content: string;
  deleted: number;
  updated_at: string;
  updated_by: string;
}

export interface EventRow {
  seq: number;
  space_id: string;
  kind: string;
  page_id: string | null;
  ref: string | null;
  title: string | null;
  actor: string;
  at: string;
}
