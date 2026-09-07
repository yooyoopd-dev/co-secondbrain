// M0 항목 9 — CO-Hub DB / blob 규모 산정.
// HUB.md가 "원본 500건 기준 수십 MB 예상 — M0에서 실측"이라 적어 둔 부분.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
const gzip = promisify(zlib.gzip);

/* ---------- 가정 (전부 명시. 바꾸면 결과가 바뀐다) ---------- */
const A = {
  sources: 500, // 원본 문서 수
  pagesPerSource: 12, // 원본 1건이 건드리는 위키 페이지 수 (gist: 10~15)
  newPageRatio: 0.25, // 그 중 신규 생성 비율. 나머지는 기존 페이지 갱신
  pageBytes: 3200, // 위키 페이지 1장 평균 크기 (front-matter 포함, UTF-8 한국어)
  revisionsPerPage: 8, // 페이지당 누적 개정 횟수
  avgBlobMB: 1.8, // 원본 파일 평균 크기
  bigBlobMB: 200, // 대형 PPT 등
  bigBlobCount: 10,
  eventBytes: 180, // events 행 1개
  eventsPerSource: 14, // 인제스트 1건이 남기는 이벤트 수
};

const MB = (b) => b / 1024 / 1024;
const fmt = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${MB(b).toFixed(1)} MB`);

/* ---------- 실제 한국어 위키 페이지를 만들어 압축률을 측정 ---------- */
function samplePage(i) {
  return `---
id: ent-vendor-${i}
type: entity
title: 협력사 ${i}호
summary: 2026년 ACME 프로젝트의 협력사. 계약 갱신일과 담당자 이력이 정리되어 있음.
aliases: [Vendor${i}, 협력사${i}]
tags: [협력사, 계약, 구매]
claims:
  - text: 계약 갱신일은 2027-01-15
    source: src-kickoff-${i}#slide-12
    confidence: EXTRACTED
  - text: 갱신 협상 주체는 구매팀
    source: src-mail-${i}#body
    confidence: INFERRED
    score: 0.75
updated: 2026-09-03T10:22:00+09:00
updated_by: hong@corp
---

# 협력사 ${i}호

협력사 ${i}호는 2026년 ACME 프로젝트의 주요 공급사로 확정되었다. [^src-kickoff-${i}#slide-12]
계약 갱신 일정에 대해 문서 간 불일치가 확인되어 구매팀에서 검토 중이다. [^src-mail-${i}#body]

## 계약
- 갱신일: 2027-01-15 [^src-kickoff-${i}#slide-12]
- 조정 요청안: 2027-03-01 [^src-mail-${i}#body]

## 관련
- [[concepts/contract-renewal|계약 갱신]]
- [[entities/purchasing-team|구매팀]]
- [[sources/kickoff-${i}|킥오프 회의록]]

## 열린 질문
- 갱신일이 문서마다 다름. 어느 쪽이 최신인지 확인 필요.
`;
}

const sample = samplePage(1);
const realBytes = Buffer.byteLength(sample, 'utf8');
const gz = await gzip(Buffer.from(sample, 'utf8'));

/* ---------- 계산 ---------- */
const pages = Math.round(A.sources * A.pagesPerSource * A.newPageRatio);
const pageBytes = realBytes; // 가정값 대신 실측값 사용
const currentTable = pages * pageBytes;
const versionsTable = pages * A.revisionsPerPage * pageBytes;
const events = A.sources * A.eventsPerSource * A.eventBytes;
const dbRaw = currentTable + versionsTable + events;

const blobs = A.sources * A.avgBlobMB * 1024 * 1024 + A.bigBlobCount * A.bigBlobMB * 1024 * 1024;

console.log('\n=== M0 항목 9 · CO-Hub 규모 산정 ===\n');
console.log('--- 실측: 한국어 위키 페이지 1장 ---');
console.log(`  원본 ${realBytes} B · gzip ${gz.length} B (압축률 ${((1 - gz.length / realBytes) * 100).toFixed(0)}%)`);
console.log(`  → 가정값 ${A.pageBytes} B 대신 실측 ${realBytes} B로 계산\n`);

console.log('--- 가정 ---');
for (const [k, v] of Object.entries(A)) console.log(`  ${k.padEnd(18)} ${v}`);

console.log('\n--- SQLite (hub.sqlite) ---');
console.log(`  위키 페이지 수          ${pages.toLocaleString()} 장`);
console.log(`  pages (현재 상태)       ${fmt(currentTable)}`);
console.log(`  page_versions (${A.revisionsPerPage}개정) ${fmt(versionsTable)}`);
console.log(`  events                  ${fmt(events)}`);
console.log(`  ─────────────────────────────────`);
console.log(`  DB 합계                 ${fmt(dbRaw)}`);
console.log(`  (참고) gzip 적용 시     ${fmt(dbRaw * (gz.length / realBytes))}`);

console.log('\n--- blob 저장소 ---');
console.log(`  일반 원본 ${A.sources}건 x ${A.avgBlobMB}MB   ${fmt(A.sources * A.avgBlobMB * 1024 * 1024)}`);
console.log(`  대형 ${A.bigBlobCount}건 x ${A.bigBlobMB}MB        ${fmt(A.bigBlobCount * A.bigBlobMB * 1024 * 1024)}`);
console.log(`  blob 합계               ${fmt(blobs)}`);

console.log('\n--- 결론 ---');
console.log(`  DB는 ${fmt(dbRaw)} — HUB.md의 "수십 MB" 예상과 부합. 전 버전 보관해도 문제 없음.`);
console.log(`  실제 용량은 blob이 ${(blobs / dbRaw).toFixed(0)}배로 압도적. 디스크 경고는 blob 기준으로 걸어야 함.`);
console.log(`  클라이언트 첫 동기화(페이지만, blob 제외)는 ${fmt(currentTable)} 전송 → 사내망에서 수 초.`);

/* ---------- 개정 횟수 민감도 ---------- */
console.log('\n--- 민감도: 페이지당 개정 횟수를 늘리면 ---');
for (const r of [4, 8, 16, 32, 64]) {
  const d = currentTable + pages * r * pageBytes + events;
  console.log(`  ${String(r).padStart(2)}개정 → DB ${fmt(d)}${r === A.revisionsPerPage ? '   (기준)' : ''}`);
}
console.log('\n  개정 64회까지 가도 1GB 미만. 버전 정리(pruning) 정책은 v1에 불필요.');

await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(
  new URL('../out/sizing.json', import.meta.url).pathname,
  JSON.stringify({ assumptions: A, measuredPageBytes: realBytes, gzipBytes: gz.length, pages, dbRaw, blobs }, null, 1),
);
