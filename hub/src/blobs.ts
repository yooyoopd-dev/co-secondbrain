// 원본 파일 저장. HUB.md §4
//
// **콘텐츠 주소 방식이다.** 같은 파일을 여러 명이 올려도 한 번만 저장된다.
//
// 스트리밍으로 받는다. HUB.md §8 이 200MB PPT 를 요건으로 적었는데 메모리에 담으면
// 그 크기에서 서버가 죽는다. 임시 파일에 흘려 쓰면서 해시를 같이 계산하고, 다 받은 뒤
// 주소로 옮긴다.
//
// **HUB.md §4 의 multipart 대신 원시 본문을 받는다.** 파일 이름과 MIME 은 질의 문자열로
// 온다. multipart 파서를 직접 쓰면 버그가 나기 쉽고 이 서버는 의존성이 없다.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';

export interface BlobMeta {
  sha256: string;
  filename: string;
  bytes: number;
  mime: string | null;
  uploaded_at: string;
  uploaded_by: string;
}

/** `blobs/9f/2a/9f2a3c...` — 앞 4자리로 분산한다. 한 디렉터리에 수만 개를 넣지 않는다. */
export function blobPath(dir: string, sha: string): string {
  return path.join(dir, sha.slice(0, 2), sha.slice(2, 4), sha);
}

export interface PutBlobResult {
  sha256: string;
  bytes: number;
  /** 이미 있던 파일인가. 같으면 디스크에 다시 쓰지 않았다 */
  dedup: boolean;
}

export async function putBlob(
  db: DatabaseSync,
  dir: string,
  spaceId: string,
  meta: { filename: string; mime: string | null },
  body: Readable,
  actor: string,
  now: string,
): Promise<PutBlobResult> {
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    body.on('data', (c: Buffer) => {
      hash.update(c);
      bytes += c.length;
    });
    await pipeline(body, createWriteStream(tmp));
    const sha256 = hash.digest('hex');
    const dest = blobPath(dir, sha256);

    const exists = await fs
      .access(dest)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      await fs.rm(tmp, { force: true });
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(tmp, dest);
    }

    // 메타는 공간마다 남긴다. 같은 파일을 두 공간이 올려도 실물은 하나다.
    db.prepare(
      `INSERT INTO blobs (space_id, sha256, filename, bytes, mime, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(space_id, sha256) DO NOTHING`,
    ).run(spaceId, sha256, meta.filename, bytes, meta.mime, now, actor);
    return { sha256, bytes, dedup: exists };
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export function blobMeta(db: DatabaseSync, spaceId: string, sha: string): BlobMeta | null {
  const row = db.prepare('SELECT * FROM blobs WHERE space_id = ? AND sha256 = ?').get(spaceId, sha) as
    | unknown
    | undefined;
  return (row as BlobMeta | undefined) ?? null;
}
