// 인제스트 프롬프트 조립. PLAN.md §7.1·§7.3, M2-PLAN.md §2.1
//
// **접두사와 가변부를 갈라 놓는 것이 이 파일의 요점이다.** 실측에서 프롬프트 접두사가
// 바이트 단위로 같으면 새 프로세스도 cache 읽기로 붙었다 (문서당 $0.13 → $0.02).
// 접두사는 작업 디렉터리의 규약 파일이고 배치 내내 같아야 한다. 문서마다 달라지는 것은
// 전부 `-p` 프롬프트 쪽에 둔다.
import { serializePage } from '../page.ts';
import type { Extraction } from '../types.ts';

/** 규약 파일에 박아 넣는 페이지 형식 표본. 직렬화기가 바뀌면 같이 바뀐다. */
export const PAGE_TEMPLATE = serializePage({
  front: {
    id: 'ent-example',
    type: 'entity',
    title: '보기',
    summary: '한 줄 요약.',
    aliases: [],
    tags: [],
    claims: [{ text: '주장 한 문장.', source: 'src-example#slide-1', confidence: 'EXTRACTED' }],
    openQuestions: [],
    classification: 'internal', docGenre: null,
    derivedFrom: null,
    generatedBy: 'claude-code',
    updated: '2026-09-05T00:00:00.000Z',
    updatedBy: 'app',
  },
  body: '\n# 보기\n\n주장 한 문장.[^src-example#slide-1]\n',
});

/**
 * 작업 디렉터리에 놓을 규약 파일. **배치 내내 같은 바이트여야 한다** —
 * 여기에 시각이나 문서 이름 같은 가변값을 넣으면 배치 전체의 캐시가 깨진다.
 *
 * @param agentsMd Vault 의 `schema/AGENTS.md` 정본 (PLAN.md §7.3)
 */
export function conventionFile(agentsMd: string): string {
  return `${agentsMd.trimEnd()}

## 페이지 형식 (앱이 만든 표본 — 키 이름과 순서를 바꾸지 않는다)

\`\`\`markdown
${PAGE_TEMPLATE}\`\`\`
`;
}

/** 위키에 이미 있는 페이지. update 를 내려면 모델이 baseHash 를 알아야 한다. */
export interface WikiRef {
  path: string;
  title: string;
  hash: string;
}

/** 문서 하나치 프롬프트. 여기는 매번 달라져도 된다 — 캐시 접두사가 아니다. */
export function promptFor(ext: Extraction, wiki: readonly WikiRef[]): string {
  const anchors = ext.chunks.map((c) => `${ext.sourceId}#${c.anchor.locator}`);
  const body = ext.chunks.map((c) => `- ${c.anchor.locator}: ${c.text}`).join('\n');
  const existing = wiki.length
    ? wiki.map((w) => `- ${w.path} — ${w.title} (baseHash \`${w.hash}\`)`).join('\n')
    : '없다. 전부 create 다.';

  return `아래 원본에서 위키를 갱신하는 ChangeSet 을 내라. 도구는 쓸 수 없다. 주어진 내용만 쓴다.

## 원본 ${ext.sourceId} (${ext.filename})

${body}

## 쓸 수 있는 앵커

${anchors.join(' · ')}

없는 앵커를 인용하면 변경안 전체가 거부된다.

## 지금 위키에 있는 페이지

${existing}

기존 페이지를 고치면 op 는 update 이고 위 baseHash 를 그대로 넣는다.
새로 만들면 op 는 create 이고 baseHash 는 null 이다.`;
}
