// `record.mjs` 의 내보내기 계약.
//
// 회수 스크립트는 사내 PC 에서 의존성 없이 돌아야 해서 `.mjs` 다. 그래서 값이 app 쪽과
// 복사돼 있고, 어긋나면 `app/test/record.test.ts` 가 잡는다. 그 테스트가 타입을 보게 한다.

export interface RecordCase {
  id: string;
  sourceId: string;
  filename: string;
  /** `[locator, text]` — 여기 있는 앵커만 실재한다. 밖을 인용하면 FAIL 이다 */
  chunks: [string, string][];
}

export interface CheckResult {
  ok: boolean;
  /** 없는 앵커 인용. 종료 코드 1 로 강제하는 검사 (CLAUDE.md §9) */
  fatal: boolean;
  reasons: string[];
}

export declare const SCHEMA: Record<string, unknown>;
export declare const PAGE_TEMPLATE: string;
export declare const CONVENTION: string;
export declare const CASES: RecordCase[];
export declare function promptFor(c: RecordCase, withSchema: boolean): string;
export declare function stripFence(s: string): string;
export declare function check(cs: unknown, c: RecordCase): CheckResult;
