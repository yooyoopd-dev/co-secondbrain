// 기여(개인 → CO) 와 채택(CO → 개인). PLAN.md §4
//
// 두 방향 모두 **ChangeSet 을 만들 뿐 디스크에 쓰지 않는다.** 관문 8(사람의 diff 승인)을
// 그대로 통과해야 한다 — 기여는 실수로 사적 메모가 나가는 것을 막는 유일한 장치라,
// 여기서 바로 쓰면 그 장치가 사라진다.
import fs from 'node:fs/promises';
import { currentHash, type ChangeSet } from '../changeset.ts';
import { citations, outboundLinks, parsePage, serializePage } from '../page.ts';
import { safeJoin } from '../security.ts';
import type { Vault } from '../vault.ts';
import { readState } from './state.ts';
import type { HubClient } from './client.ts';

export interface TransferPlan {
  changeSet: ChangeSet;
  /**
   * 옮기는 페이지가 인용한 앵커. 대상 Vault 에는 원본 파일이 없어서 관문 5 가 전부 막는다.
   * **이 맵은 원본 공간의 주장을 그대로 옮긴 것이고, 대상 Vault 에서 검증되지 않는다.**
   * 부르는 쪽이 로컬 앵커와 합쳐 `buildReview` 에 넘긴다.
   */
  attestedAnchors: Map<string, Set<string>>;
  /** 대상 Vault 에 없는 wikilink. 끊긴 링크로 남는다 */
  danglingLinks: string[];
}

/** `co://ACME/entities/acme-corp@v12` (PLAN.md §3) */
export function coUri(spaceId: string, relPath: string, version: number | null): string {
  const slug = relPath.replace(/^02_NOTES\//, '').replace(/\.md$/, '');
  return `co://${spaceId}/${slug}${version === null ? '' : `@v${version}`}`;
}

export function parseCoUri(uri: string): { spaceId: string; slug: string; version: number | null } | null {
  const m = /^co:\/\/([^/]+)\/(.+?)(?:@v(\d+))?$/.exec(uri);
  if (!m) return null;
  return { spaceId: m[1]!, slug: m[2]!, version: m[3] === undefined ? null : Number(m[3]) };
}

/** 개인 → CO. 페이지 전문이 검토 화면에 뜨고, 사람이 승인해야 CO Vault 에 들어간다. */
export async function contributePlan(from: Vault, relPath: string, to: Vault): Promise<TransferPlan> {
  if (!to.config.hub) throw new Error('대상이 CO 공간이 아닙니다');
  const page = parsePage(await fs.readFile(safeJoin(from.root, relPath), 'utf8'));
  const content = serializePage(page);
  const baseHash = await currentHash(to, relPath);

  return {
    changeSet: {
      summary: `${from.config.title} 에서 기여: ${page.front.title}`,
      discussion: '개인 Vault 의 내용이 CO 공간으로 나갑니다. 전문을 확인하고 승인하십시오.',
      ops: [
        baseHash === null
          ? { op: 'create', path: relPath, baseHash: null, content }
          : { op: 'update', path: relPath, baseHash, content },
      ],
    },
    attestedAnchors: anchorsOf(content),
    danglingLinks: await dangling(to, page.body),
  };
}

/**
 * CO → 개인. 원본 판본을 `derived_from` 에 적어 둔다. 이 값이 있어야 나중에
 * "채택본 낡음" 을 판정할 수 있다.
 */
export async function adoptPlan(from: Vault, relPath: string, to: Vault): Promise<TransferPlan> {
  if (!from.config.hub) throw new Error('원본이 CO 공간이 아닙니다');
  const page = parsePage(await fs.readFile(safeJoin(from.root, relPath), 'utf8'));

  // 판본은 동기화 상태에서 온다. 한 번도 안 맞춰 봤으면 판본 없이 적는다
  const state = await readState(from);
  const version = state.pages[page.front.id]?.version ?? null;

  const content = serializePage({
    ...page,
    front: { ...page.front, derivedFrom: coUri(from.config.id, relPath, version) },
  });
  const baseHash = await currentHash(to, relPath);

  return {
    changeSet: {
      summary: `${from.config.title} 에서 채택: ${page.front.title}`,
      ops: [
        baseHash === null
          ? { op: 'create', path: relPath, baseHash: null, content }
          : { op: 'update', path: relPath, baseHash, content },
      ],
    },
    attestedAnchors: anchorsOf(content),
    danglingLinks: await dangling(to, page.body),
  };
}

export interface Adoption {
  path: string;
  title: string;
  uri: string;
  spaceId: string;
  /** 채택했을 때의 판본. 모르면 null */
  adoptedVersion: number | null;
  /** 허브의 지금 판본. 못 물어봤으면 null */
  currentVersion: number | null;
  /** 원본이 그 뒤로 바뀌었는가. 판단할 재료가 없으면 null */
  stale: boolean | null;
}

/**
 * 개인 Vault 의 채택본이 낡았는지 본다 (PLAN.md §4 "채택본 낡음 배지").
 * 허브에 못 닿으면 `currentVersion` 이 null 로 남고 배지는 뜨지 않는다.
 */
export async function staleAdoptions(personal: Vault, client: HubClient | null): Promise<Adoption[]> {
  const { readWikiPages } = await import('../wiki.ts');
  const { entries } = await readWikiPages(personal);
  const out: Adoption[] = [];

  for (const e of entries) {
    const uri = e.page.front.derivedFrom;
    if (!uri) continue;
    const parsed = parseCoUri(uri);
    if (!parsed) continue;

    let currentVersion: number | null = null;
    if (client) {
      const remote = await client.getPage(parsed.spaceId, e.page.front.id);
      currentVersion = remote?.version ?? null;
    }
    out.push({
      path: e.path,
      title: e.page.front.title,
      uri,
      spaceId: parsed.spaceId,
      adoptedVersion: parsed.version,
      currentVersion,
      stale: parsed.version === null || currentVersion === null ? null : currentVersion > parsed.version,
    });
  }
  return out;
}

function anchorsOf(content: string): Map<string, Set<string>> {
  const page = parsePage(content);
  const map = new Map<string, Set<string>>();
  const add = (sourceId: string, locator: string): void => {
    let set = map.get(sourceId);
    if (!set) map.set(sourceId, (set = new Set()));
    set.add(locator);
  };
  for (const c of citations(page.body)) add(c.sourceId, c.locator);
  for (const c of page.front.claims) {
    if (!c.source?.includes('#')) continue;
    const [sourceId, ...rest] = c.source.split('#');
    add(sourceId!, rest.join('#'));
  }
  return map;
}

/** 두 앵커 맵을 합친다. 로컬에서 검증된 것이 우선이다. */
export function mergeAnchors(
  local: ReadonlyMap<string, ReadonlySet<string>>,
  attested: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of attested) out.set(k, new Set(v));
  for (const [k, v] of local) {
    const set = out.get(k);
    if (set) for (const l of v) set.add(l);
    else out.set(k, new Set(v));
  }
  return out;
}

async function dangling(to: Vault, body: string): Promise<string[]> {
  const out: string[] = [];
  for (const link of outboundLinks(body)) {
    const rel = link.startsWith('02_NOTES/') ? `${link}.md` : `02_NOTES/${link}.md`;
    try {
      await fs.access(safeJoin(to.root, rel));
    } catch {
      out.push(link);
    }
  }
  return out;
}
