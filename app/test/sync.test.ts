import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault, type Vault } from '../src/core/vault.ts';
import { emptyPage, pageHash, parsePage, serializePage } from '../src/core/page.ts';
import { hasMarkers, merge3 } from '../src/core/sync/merge.ts';
import { pendingChanges, resolveConflict, scanLocal, sync } from '../src/core/sync/engine.ts';
import { readState } from '../src/core/sync/state.ts';
import { HubOffline, type HubClient, type RemotePage, type WriteOutcome } from '../src/core/sync/client.ts';
import { adoptPlan, contributePlan, coUri, parseCoUri, staleAdoptions } from '../src/core/sync/transfer.ts';

/* ---------------- 3-way 병합 ---------------- */

const L = (...a: string[]) => a.join('\n') + '\n';

test('한쪽만 고친 구간은 그쪽을 따른다', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'B', 'c'), L('a', 'b', 'c'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('a', 'B', 'c'));
});

test('양쪽이 서로 다른 줄을 고치면 둘 다 살린다', () => {
  const r = merge3(L('a', 'b', 'c'), L('A', 'b', 'c'), L('a', 'b', 'C'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('A', 'b', 'C'));
});

test('양쪽이 같은 고침을 내면 한 번만 넣는다', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'X', 'c'), L('a', 'X', 'c'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('a', 'X', 'c'));
});

test('서버가 지운 줄은 병합 결과에서도 빠진다', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'b', 'c'), L('a', 'c'));
  assert.equal(r.clean, true);
  assert.equal(r.text, L('a', 'c'));
});

test('같은 줄을 서로 다르게 고치면 충돌 표시를 남기고 임의로 고르지 않는다', () => {
  const r = merge3(L('a', 'b', 'c'), L('a', 'X', 'c'), L('a', 'Y', 'c'));
  assert.equal(r.clean, false);
  assert.equal(r.conflicts, 1);
  assert.match(r.text, /<<<<<<< 내 것\nX\n\|\|\|\|\|\|\| 기준\nb\n=======\nY\n>>>>>>> 서버/);
  assert.equal(hasMarkers(r.text), true);
});

test('충돌 표시가 없으면 hasMarkers 는 false', () => {
  assert.equal(hasMarkers(L('a', 'b')), false);
});

/* ---------------- 가짜 허브 ---------------- */

interface Stored {
  path: string;
  version: number;
  content: string;
  deleted: boolean;
}

/** 허브의 판정만 옮긴 것. 트랜잭션·인증은 hub/ 쪽 테스트가 본다 */
class FakeHub implements HubClient {
  pages = new Map<string, Stored>();
  events: { seq: number; kind: string; page_id: string | null }[] = [];
  down = false;
  private seq = 0;

  private guard(): void {
    if (this.down) throw new HubOffline('테스트: 허브가 꺼져 있습니다');
  }
  private event(pageId: string): void {
    this.events.push({ seq: ++this.seq, kind: 'page', page_id: pageId });
  }

  async spaces() {
    this.guard();
    return [{ id: 'ACME', title: 'ACME', role: 'writer' as const }];
  }

  async changes(_s: string, since: number) {
    this.guard();
    const events = this.events.filter((e) => e.seq > since);
    return {
      events: events as never,
      nextSeq: events.length ? events[events.length - 1]!.seq : since,
      hasMore: false,
    };
  }

  async getPage(_s: string, pageId: string): Promise<RemotePage | null> {
    this.guard();
    const p = this.pages.get(pageId);
    if (!p || p.deleted) return null;
    return {
      pageId, path: p.path, version: p.version, hash: pageHash(p.content),
      content: p.content, updatedBy: '남', updatedAt: '2026-09-06T00:00:00.000Z', deleted: false,
    };
  }

  async putPage(_s: string, pageId: string, input: { path: string; content: string; baseVersion: number | null }): Promise<WriteOutcome> {
    this.guard();
    const cur = this.pages.get(pageId);
    const mismatch = input.baseVersion === null ? !!cur && !cur.deleted : !cur || cur.version !== input.baseVersion;
    if (mismatch) {
      return {
        ok: false,
        conflict: {
          serverVersion: cur?.version ?? 0,
          serverContent: cur?.content ?? '',
          baseContent: null,
        },
      };
    }
    const version = (cur?.version ?? 0) + 1;
    this.pages.set(pageId, { path: input.path, version, content: input.content, deleted: false });
    this.event(pageId);
    return { ok: true, version, hash: pageHash(input.content) };
  }

  async deletePage(_s: string, pageId: string, baseVersion: number): Promise<WriteOutcome> {
    this.guard();
    const cur = this.pages.get(pageId);
    if (!cur || cur.deleted || cur.version !== baseVersion) {
      return { ok: false, conflict: { serverVersion: cur?.version ?? 0, serverContent: cur?.content ?? '', baseContent: null } };
    }
    cur.version += 1;
    cur.deleted = true;
    this.event(pageId);
    return { ok: true, version: cur.version, hash: null };
  }

  /** 남이 허브에 직접 쓴 상황 */
  outside(pageId: string, relPath: string, content: string): void {
    const cur = this.pages.get(pageId);
    this.pages.set(pageId, { path: relPath, version: (cur?.version ?? 0) + 1, content, deleted: false });
    this.event(pageId);
  }
}

/* ---------------- 금고 도우미 ---------------- */

const coVault = async (): Promise<Vault> =>
  createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sync-co-')), { id: 'ACME', title: 'ACME', hub: 'http://hub' });

const personalVault = async (): Promise<Vault> =>
  createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sync-me-')), { id: 'personal', title: '내 금고', hub: null });

const md = (slug: string, body: string): string => {
  const page = emptyPage(slug, 'entity', slug);
  page.front.updated = '2026-09-06T00:00:00.000Z';
  page.body = `\n${body}\n`;
  return serializePage(page);
};

const put = async (v: Vault, rel: string, text: string): Promise<void> => {
  await fs.mkdir(path.join(v.root, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(v.root, rel), text, 'utf8');
};

const read = (v: Vault, rel: string) => fs.readFile(path.join(v.root, rel), 'utf8');

const REL = '02_NOTES/entities/acme-corp.md';

/* ---------------- 스캔과 보류 변경 ---------------- */

test('보류 변경은 큐 파일이 아니라 디스크와 기준본의 차이로 계산된다', async () => {
  const v = await coVault();
  await put(v, REL, md('acme-corp', '첫 줄'));
  const scan = await scanLocal(v);
  assert.equal(scan.pages.size, 1);

  const none = pendingChanges({ cursor: 0, pages: {} }, scan.pages);
  assert.equal(none[0]!.kind, 'create');

  const synced = { cursor: 0, pages: { 'acme-corp': { pageId: 'acme-corp', path: REL, version: 1, hash: scan.pages.get('acme-corp')!.hash } } };
  assert.equal(pendingChanges(synced, scan.pages).length, 0);
  assert.equal(pendingChanges(synced, new Map()).length, 1);
  assert.equal(pendingChanges(synced, new Map())[0]!.kind, 'delete');
});

test('front-matter 가 깨진 파일은 동기화에서 빠지고 이유가 남는다', async () => {
  const v = await coVault();
  await put(v, REL, '앞머리 없음');
  const scan = await scanLocal(v);
  assert.equal(scan.pages.size, 0);
  assert.equal(scan.skipped.length, 1);
});

/* ---------------- 왕복 ---------------- */

test('처음 동기화하면 로컬 페이지가 허브로 올라간다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '첫 줄'));

  const r = await sync(v, hub);
  assert.equal(r.pushed.length, 1);
  assert.equal(r.conflicts.length, 0);
  assert.equal(hub.pages.get('acme-corp')!.version, 1);

  // 두 번째는 아무것도 안 한다
  const again = await sync(v, hub);
  assert.deepEqual([again.pushed.length, again.pulled.length, again.conflicts.length], [0, 0, 0]);
});

test('남이 올린 변경은 로컬에 그대로 반영된다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  hub.outside('acme-corp', REL, md('acme-corp', '남이 쓴 줄'));

  const r = await sync(v, hub);
  assert.equal(r.pulled.length, 1);
  assert.match(await read(v, REL), /남이 쓴 줄/);
  assert.equal((await readState(v)).pages['acme-corp']!.version, 1);
});

test('허브가 준 경로가 형식에 맞지 않으면 쓰지 않는다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  hub.outside('acme-corp', '../../탈출.md', md('acme-corp', '나쁜 경로'));

  const r = await sync(v, hub);
  assert.equal(r.pulled.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /형식에 맞지 않습니다/);
});

test('원격에서 지운 페이지는 로컬에서도 사라진다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '첫 줄'));
  await sync(v, hub);

  await hub.deletePage('ACME', 'acme-corp', 1);
  const r = await sync(v, hub);
  assert.equal(r.pulled[0]!.kind, 'delete');
  await assert.rejects(() => read(v, REL));
  assert.equal((await readState(v)).pages['acme-corp'], undefined);
});

test('로컬에서 지운 페이지는 허브에서도 지워진다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '첫 줄'));
  await sync(v, hub);

  await fs.rm(path.join(v.root, REL));
  const r = await sync(v, hub);
  assert.equal(r.pushed[0]!.kind, 'delete');
  assert.equal(hub.pages.get('acme-corp')!.deleted, true);
});

/* ---------------- 오프라인과 충돌 ---------------- */

test('허브에 못 닿으면 오프라인으로 보고하고 로컬 변경을 그대로 둔다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '첫 줄'));
  hub.down = true;

  const r = await sync(v, hub);
  assert.equal(r.offline, true);
  assert.equal(r.pushed.length, 0);

  hub.down = false;
  const back = await sync(v, hub);
  assert.equal(back.pushed.length, 1);
});

test('오프라인 편집이 남의 편집과 겹치면 병합안을 만들고 아무것도 쓰지 않는다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '공통 줄'));
  await sync(v, hub);

  // 남이 허브를 고치는 동안 나는 오프라인으로 같은 줄을 고쳤다
  const base = await read(v, REL);
  hub.outside('acme-corp', REL, base.replace('공통 줄', '남의 줄'));
  await put(v, REL, base.replace('공통 줄', '내 줄'));

  const r = await sync(v, hub);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0]!;
  assert.equal(c.merged.clean, false);
  assert.match(c.merged.text, /내 줄[\s\S]*남의 줄/);
  // 디스크는 그대로다
  assert.match(await read(v, REL), /내 줄/);
  assert.equal(hub.pages.get('acme-corp')!.content.includes('남의 줄'), true);

  // 사람이 고른 결과를 올린다
  const merged = base.replace('공통 줄', '내 줄과 남의 줄');
  const done = await resolveConflict(v, hub, c, merged);
  assert.equal(done.ok, true);
  assert.match(await read(v, REL), /내 줄과 남의 줄/);
  assert.equal((await sync(v, hub)).conflicts.length, 0);
});

test('충돌 표시가 남은 병합 결과는 올리지 않는다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '공통 줄'));
  await sync(v, hub);
  const base = await read(v, REL);
  hub.outside('acme-corp', REL, base.replace('공통 줄', '남의 줄'));
  await put(v, REL, base.replace('공통 줄', '내 줄'));

  const c = (await sync(v, hub)).conflicts[0]!;
  const bad = await resolveConflict(v, hub, c, c.merged.text);
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /충돌 표시/);
});

test('병합 결과가 페이지 형식이 아니면 거절한다', async () => {
  const v = await coVault();
  const hub = new FakeHub();
  await put(v, REL, md('acme-corp', '공통 줄'));
  await sync(v, hub);
  const base = await read(v, REL);
  hub.outside('acme-corp', REL, base.replace('공통 줄', '남의 줄'));
  await put(v, REL, base.replace('공통 줄', '내 줄'));

  const c = (await sync(v, hub)).conflicts[0]!;
  const bad = await resolveConflict(v, hub, c, '앞머리 없는 본문');
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /페이지 형식/);
});

/* ---------------- 기여 · 채택 ---------------- */

test('기여는 ChangeSet 만 만들고 대상 금고에 쓰지 않는다', async () => {
  const me = await personalVault();
  const co = await coVault();
  await put(me, REL, md('acme-corp', '개인 메모'));

  const plan = await contributePlan(me, REL, co);
  assert.equal(plan.changeSet.ops[0]!.op, 'create');
  assert.match(plan.changeSet.discussion!, /전문을 확인/);
  await assert.rejects(() => read(co, REL));
});

test('채택은 derived_from 에 원본 판본을 적는다', async () => {
  const co = await coVault();
  const me = await personalVault();
  const hub = new FakeHub();
  await put(co, REL, md('acme-corp', 'CO 내용'));
  await sync(co, hub);

  const plan = await adoptPlan(co, REL, me);
  const page = parsePage(plan.changeSet.ops[0]!.content!);
  assert.equal(page.front.derivedFrom, 'co://ACME/entities/acme-corp@v1');
});

test('채택본은 원본이 올라가면 낡음으로 표시된다', async () => {
  const co = await coVault();
  const me = await personalVault();
  const hub = new FakeHub();
  await put(co, REL, md('acme-corp', 'CO 내용'));
  await sync(co, hub);

  const plan = await adoptPlan(co, REL, me);
  await put(me, REL, plan.changeSet.ops[0]!.content!);

  const before = await staleAdoptions(me, hub);
  assert.equal(before[0]!.stale, false);

  hub.outside('acme-corp', REL, md('acme-corp', '고쳐진 CO 내용'));
  const after = await staleAdoptions(me, hub);
  assert.equal(after[0]!.stale, true);
  assert.deepEqual([after[0]!.adoptedVersion, after[0]!.currentVersion], [1, 2]);
});

test('허브에 못 물어보면 낡음 판정을 유보한다', async () => {
  const co = await coVault();
  const me = await personalVault();
  const hub = new FakeHub();
  await put(co, REL, md('acme-corp', 'CO 내용'));
  await sync(co, hub);
  await put(me, REL, (await adoptPlan(co, REL, me)).changeSet.ops[0]!.content!);

  const r = await staleAdoptions(me, null);
  assert.equal(r[0]!.stale, null);
});

test('co:// URI 는 왕복한다', () => {
  assert.equal(coUri('ACME', '02_NOTES/entities/acme-corp.md', 12), 'co://ACME/entities/acme-corp@v12');
  assert.deepEqual(parseCoUri('co://ACME/entities/acme-corp@v12'), { spaceId: 'ACME', slug: 'entities/acme-corp', version: 12 });
  assert.deepEqual(parseCoUri('co://ACME/entities/acme-corp'), { spaceId: 'ACME', slug: 'entities/acme-corp', version: null });
  assert.equal(parseCoUri('https://example.com'), null);
});
