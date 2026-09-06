// M1 선행 실측 — SQLite FTS5 의 한국어 토크나이징.
//
// FTS5 기본 토크나이저(unicode61)는 공백·구두점으로만 자른다.
// 한국어는 조사가 어절에 붙으므로 "에이콤이"가 한 토큰이 되어 "에이콤"으로 검색되지 않는다.
// M1 의 핵심 기능이 검색이라 여기서 막히면 설계를 바꿔야 한다.
//
// 후보: unicode61(기본) / unicode61 + 접두 질의 / trigram
// 판정 기준: 실제 업무 문서에서 사람이 칠 법한 질의가 걸리는가. 오검색은 감점.
import { DatabaseSync } from 'node:sqlite';

/* ---------- 코퍼스: 우리 추출기가 낼 법한 실제 모양 ---------- */
const DOCS = [
  { id: 'src-kickoff#slide-2', text: '에이콤(주)이 2026년 ACME 프로젝트의 주 협력사로 확정되었다.' },
  { id: 'src-kickoff#slide-12', text: '계약 갱신일은 2027-01-15이며 구매팀이 최종 검토를 맡는다.' },
  { id: 'src-mail-a41f#body', text: '에이콤의 김철수 담당자가 갱신일을 2027-03-01로 조정해달라고 요청했다.' },
  { id: 'src-mail-b22c#body', text: '홍길동 과장은 내부 검토 후 회신하겠다고 답신했다.' },
  { id: 'src-arch#page-3', text: '데이터센터 이관은 클라우드 마이그레이션 로드맵의 2단계에 해당한다.' },
  { id: 'src-cost#원가!D4', text: '라이선스 단가 1,200,000원에 수량 12를 곱한 금액이 합계에 반영된다.' },
  { id: 'src-sec#page-1', text: '접근 통제 정책은 보안팀이 관리하며 분기마다 감사를 수행한다.' },
  { id: 'src-vtt#t-00:00:05', text: '홍길동: 에이콤 계약 갱신일이 문서마다 다릅니다.' },
];

/* ---------- 질의: 사람이 실제로 칠 법한 것 ---------- */
// want = 걸려야 하는 문서 id 접두사, avoid = 걸리면 오검색
const QUERIES = [
  { q: '에이콤', want: ['src-kickoff#slide-2', 'src-mail-a41f', 'src-vtt'], note: '어절 일부 (조사·괄호 붙음)' },
  { q: '갱신일', want: ['src-kickoff#slide-12', 'src-mail-a41f', 'src-vtt'], note: '어절 일부 (은/을 붙음)' },
  { q: '계약', want: ['src-kickoff#slide-12', 'src-vtt'], note: '2음절' },
  { q: '협력사', want: ['src-kickoff#slide-2'], note: '어절 일부 (로 붙음)' },
  { q: '구매팀', want: ['src-kickoff#slide-12'], note: '어절 일부 (이 붙음)' },
  { q: '김철수', want: ['src-mail-a41f'], note: '인명' },
  { q: '마이그레이션', want: ['src-arch'], note: '외래어 장음절' },
  { q: '보안', want: ['src-sec'], note: '2음절, 다른 어절 안에 있음(보안팀)' },
  { q: '이관', want: ['src-arch'], note: '2음절, 어절 시작' },
  { q: '검토', want: ['src-kickoff#slide-12', 'src-mail-b22c'], note: '2음절, 어절 시작' },
  { q: 'ACME', want: ['src-kickoff#slide-2'], note: '영문' },
  { q: '2027', want: ['src-kickoff#slide-12', 'src-mail-a41f'], note: '숫자' },

  // --- 접두 방식의 약점을 겨냥한 적대적 질의 ---
  { q: '센터', want: ['src-arch'], note: '★어절 중간 (데이터센터) — 접두는 못 잡음' },
  { q: '통제', want: ['src-sec'], note: '★어절 중간? (접근 통제) — 실은 어절 시작' },
  { q: '이', want: [], note: '★1음절 조사 — 오검색이 터지는가' },
  { q: '검', want: [], note: '★1음절 — 거부가 정답(오검색 방지)' },
];

/* ---------- 전략 ---------- */
const STRATEGIES = {
  'unicode61 (기본)': {
    create: (db) => db.exec(`CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, text)`),
    query: (q) => `"${q}"`,
  },
  'unicode61 + 접두(*)': {
    create: (db) => db.exec(`CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, text)`),
    query: (q) => `"${q}"*`,
  },
  trigram: {
    create: (db) => db.exec(`CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, text, tokenize='trigram')`),
    query: (q) => `"${q}"`,
  },
  // ★ 하이브리드 — FTS5 는 테이블 단위로 토크나이저가 정해지므로 두 개를 만든다.
  //    접두(unicode61): 어절 시작 매칭. 2음절도 잡는다. 어절 중간은 못 잡는다.
  //    trigram:        어절 중간 부분 문자열. 단 3자 이상만.
  //    질의 길이로 갈라서 합집합을 낸다.
  '★ 하이브리드': { hybrid: true },
};

// 한국어 조사 — 어절 끝에서 떼어 낸 형태를 색인에 추가한다.
const JOSA = /(으로부터|에게서|이라고|라고|으로서|로서|으로|에서|에게|과의|와의|이며|이라|라는|이는|은|는|이|가|을|를|의|와|과|도|만|에|로)$/;
function augment(text) {
  const extra = new Set();
  for (const w of text.split(/[\s,.()[\]{}·"']+/)) {
    if (w.length < 3) continue;
    const stem = w.replace(JOSA, '');
    if (stem.length >= 2 && stem !== w) extra.add(stem);
  }
  return extra.size ? `${text} ${[...extra].join(' ')}` : text;
}

/** 하이브리드 검색 — 질의 길이로 전략을 가른다.
 *   1자    거부. 접두 매칭이 폭발해 오검색만 낸다 (실측 +2건)
 *   2자    접두 FTS + LIKE 폴백 (trigram 은 3자 미만을 매칭하지 못함)
 *   3자+   접두 FTS + trigram FTS 합집합
 */
function searchHybrid(db, q) {
  const len = [...q].length;
  if (len < 2) return [];                       // 1자 질의 거부
  const seen = new Set();
  const push = (rows) => { for (const r of rows) seen.add(r.id); };

  push(db.prepare('SELECT id FROM fp WHERE fp MATCH ? ORDER BY rank').all(`"${q}"*`));

  if (len >= 3) {
    push(db.prepare('SELECT id FROM ft WHERE ft MATCH ? ORDER BY rank').all(`"${q}"`));
  } else {
    // 2자: 어절 중간 매칭을 LIKE 로 보완한다.
    // 위키는 수천 페이지 규모라 전체 스캔이 허용된다 (규모 확인은 아래 벤치).
    push(db.prepare("SELECT id FROM docs WHERE text LIKE '%' || ? || '%'").all(q));
  }
  return [...seen];
}

function evaluate(name, strat) {
  const db = new DatabaseSync(':memory:');
  if (strat.hybrid) {
    db.exec(`CREATE VIRTUAL TABLE fp USING fts5(id UNINDEXED, text)`);
    db.exec(`CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, text, tokenize='trigram')`);
    db.exec(`CREATE TABLE docs(id TEXT PRIMARY KEY, text TEXT)`);   // 2자 질의 LIKE 폴백용
    const a = db.prepare('INSERT INTO fp(id, text) VALUES (?, ?)');
    const b = db.prepare('INSERT INTO ft(id, text) VALUES (?, ?)');
    const c = db.prepare('INSERT INTO docs(id, text) VALUES (?, ?)');
    for (const d of DOCS) { a.run(d.id, d.text); b.run(d.id, d.text); c.run(d.id, d.text); }
  } else {
    strat.create(db);
    const ins = db.prepare('INSERT INTO f(id, text) VALUES (?, ?)');
    for (const d of DOCS) ins.run(d.id, strat.augment ? augment(d.text) : d.text);
  }

  let tp = 0;
  let fn = 0;
  let fp = 0;
  const rows = [];
  for (const { q, want, note } of QUERIES) {
    let hits = [];
    let err = null;
    try {
      hits = strat.hybrid
        ? searchHybrid(db, q)
        : db.prepare('SELECT id FROM f WHERE f MATCH ? ORDER BY rank').all(strat.query(q)).map((r) => r.id);
    } catch (e) {
      err = e.message.slice(0, 40);
    }
    const hit = want.filter((w) => hits.some((h) => h.startsWith(w))).length;
    const extra = hits.filter((h) => !want.some((w) => h.startsWith(w))).length;
    tp += hit;
    fn += want.length - hit;
    fp += extra;
    rows.push({ q, note, got: `${hit}/${want.length}`, extra, err, ok: hit === want.length && extra === 0 });
  }
  db.close();
  return { name, tp, fn, fp, rows, recall: tp / (tp + fn), precision: tp + fp ? tp / (tp + fp) : 1 };
}

console.log('\n=== M1 선행 · FTS5 한국어 토크나이징 실측 ===\n');
console.log(`문서 ${DOCS.length}건 · 질의 ${QUERIES.length}건 (사람이 실제로 칠 법한 형태)\n`);

const results = Object.entries(STRATEGIES).map(([n, s]) => evaluate(n, s));

console.log('  전략                      재현율  정밀도  놓침  오검색');
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(24)} ${r.recall.toFixed(3)}   ${r.precision.toFixed(3)}   ${String(r.fn).padStart(3)}   ${String(r.fp).padStart(4)}`,
  );
}

console.log('\n--- 질의별 상세 ---');
console.log(`  ${'질의'.padEnd(14)}${results.map((r) => r.name.slice(0, 12).padEnd(14)).join('')}`);
for (let i = 0; i < QUERIES.length; i++) {
  const cells = results.map((r) => {
    const c = r.rows[i];
    return (c.err ? 'ERR' : `${c.got}${c.extra ? `+${c.extra}` : ''}`).padEnd(14);
  });
  console.log(`  ${QUERIES[i].q.padEnd(14)}${cells.join('')}  ${QUERIES[i].note}`);
}

const best = results.slice().sort((a, b) => b.recall - a.recall || a.fp - b.fp)[0];
console.log(`\n--- 권장: ${best.name} ---`);
console.log(`  재현율 ${best.recall.toFixed(3)} · 정밀도 ${best.precision.toFixed(3)} · 놓침 ${best.fn} · 오검색 ${best.fp}`);
const missed = best.rows.filter((r) => !r.ok);
if (missed.length) {
  console.log('  아직 불완전한 질의:');
  for (const m of missed) console.log(`    ${m.q.padEnd(12)} ${m.got}${m.extra ? ` (+오검색 ${m.extra})` : ''}  ${m.note}`);
} else {
  console.log('  전 질의 완전 일치');
}

/* ---------- 규모 벤치 — LIKE 폴백이 실제 위키 크기에서 견디는가 ---------- */
// M0 sizing 실측: 위키 페이지 1장 ≈ 1,114 B, 원본 500건 프로젝트 ≈ 1,500장
console.log('\n--- 규모 벤치 (2자 질의 = LIKE 전체 스캔) ---');
const FILLER = [
  '에이콤(주)이 2026년 ACME 프로젝트의 주 협력사로 확정되었다.',
  '계약 갱신일은 2027-01-15이며 구매팀이 최종 검토를 맡는다.',
  '데이터센터 이관은 클라우드 마이그레이션 로드맵의 2단계에 해당한다.',
  '접근 통제 정책은 보안팀이 관리하며 분기마다 감사를 수행한다.',
];
for (const n of [1_500, 10_000, 50_000]) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE fp USING fts5(id UNINDEXED, text)`);
  db.exec(`CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, text, tokenize='trigram')`);
  db.exec(`CREATE TABLE docs(id TEXT PRIMARY KEY, text TEXT)`);
  const a = db.prepare('INSERT INTO fp(id, text) VALUES (?, ?)');
  const b = db.prepare('INSERT INTO ft(id, text) VALUES (?, ?)');
  const c = db.prepare('INSERT INTO docs(id, text) VALUES (?, ?)');
  const t0 = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    // 페이지 1장 ≈ 1,114 B 가 되도록 채운다
    const text = `${FILLER[i % 4]} ${FILLER[(i + 1) % 4]} ${FILLER[(i + 2) % 4]} 문서번호 ${i}`;
    a.run(`p${i}`, text); b.run(`p${i}`, text); c.run(`p${i}`, text);
  }
  db.exec('COMMIT');
  const build = Date.now() - t0;

  const bench = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r.length]; };
  const [msPrefix, nPrefix] = bench(() => db.prepare('SELECT id FROM fp WHERE fp MATCH ? LIMIT 50').all('"에이콤"*'));
  const [msTri]    = bench(() => db.prepare('SELECT id FROM ft WHERE ft MATCH ? LIMIT 50').all('"마이그레이션"'));
  const [msLike]   = bench(() => db.prepare("SELECT id FROM docs WHERE text LIKE '%' || ? || '%' LIMIT 50").all('센터'));
  console.log(
    `  ${String(n).padStart(6)}장  색인 ${String(build).padStart(5)}ms | 접두 ${msPrefix.toFixed(1)}ms · trigram ${msTri.toFixed(1)}ms · LIKE ${msLike.toFixed(1)}ms`,
  );
  db.close();
}
console.log('\n  LIKE 는 2자 질의에만 쓰이고 LIMIT 이 걸린다. 위 수치가 허용 범위인지로 판단한다.');
