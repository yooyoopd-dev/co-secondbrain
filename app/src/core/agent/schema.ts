// ChangeSet JSON Schema — A등급 CLI 에 강제로 물린다. PLAN.md §7.1
//
// **이건 첫 번째 방어선이지 마지막이 아니다.** M0 §1.4 에서 모델이 지시를 무시하고
// `entities/에이콤(주).md` 를 냈다. 스키마를 통과해도 changeset.ts 의 관문 7개를
// 다시 통과해야 디스크에 닿는다. 여기서 거르는 건 왕복 한 번을 아끼려는 것뿐이다.
import { OVERVIEW_PATH, PAGE_PATH_RE } from '../changeset.ts';

/** 관문 2 와 같은 제약. 두 곳이 어긋나지 않도록 상수에서 만든다. */
const PATH_PATTERN = `(?:^${OVERVIEW_PATH.replace('.', '\\.')}$)|(?:${PAGE_PATH_RE.source})`;

export const CHANGESET_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '이 변경안이 무엇을 하는지 한국어 한 줄. diff 검토 화면 제목이 된다',
    },
    discussion: {
      type: 'string',
      description: '사람에게 물을 것이 있으면 여기에. 없으면 생략한다',
    },
    ops: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'update', 'delete'] },
          path: { type: 'string', pattern: PATH_PATTERN },
          baseHash: {
            type: ['string', 'null'],
            description: 'update·delete 는 지금 페이지의 해시, create 는 null',
          },
          content: {
            type: 'string',
            description: 'YAML front-matter 로 시작하는 페이지 전문. delete 는 생략한다',
          },
        },
        required: ['op', 'path', 'baseHash'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'ops'],
  additionalProperties: false,
} as const;

/**
 * `pattern` 을 뺀 판본. 공급자가 정규식을 거부하면 이걸 쓴다.
 * 관문 2 가 어차피 같은 검사를 하므로 안전성은 그대로다.
 */
export function schemaWithoutPattern(): object {
  const s = structuredClone(CHANGESET_SCHEMA) as {
    properties: { ops: { items: { properties: { path: { pattern?: string } } } } };
  };
  delete s.properties.ops.items.properties.path.pattern;
  return s;
}
