// M0 보강 — 계획서 §9.2 sanitizeTitle 검증.
// "LLM이 쓴 페이지 제목이 곧 파일 이름이 된다"는 위험을 실제 공격 문자열로 확인한다.
// 제어문자는 전부 이스케이프 시퀀스로만 표기한다 (소스에 리터럴로 넣으면 파일이 깨진다).
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// C0/C1 제어문자 + zero-width + BiDi 제어 + BOM
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function slugify(title) {
  let s = String(title).normalize('NFKC');
  s = s.replace(INVISIBLE, '');
  s = s.replace(/[/\\]/g, '-'); // 경로 구분자
  s = s.replace(/[<>:"|?*]/g, ''); // Windows 금지 문자
  s = s.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, ''); // 연속·선후행 마침표 (`..` 무력화)
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (RESERVED.test(s)) s = `_${s}`;
  s = [...s].slice(0, 80).join('');
  return s || 'untitled';
}

function safeJoin(vaultRoot, relDir, title) {
  const file = `${slugify(title)}.md`;
  const full = path.resolve(vaultRoot, relDir, file);
  const root = path.resolve(vaultRoot) + path.sep;
  if (!full.startsWith(root)) throw new Error(`경로 탈출 차단: ${full}`);
  return full;
}

const VAULT = '/vault';
const ATTACKS = [
  ['../../../Windows/System32/drivers/etc/hosts', '경로 탈출'],
  ['..\\..\\..\\secrets', '역슬래시 탈출'],
  ['/etc/passwd', '절대 경로'],
  ['CON', 'Windows 예약어'],
  ['nul.md', '예약어 + 확장자'],
  ['aux', '예약어 소문자'],
  ['보고서\u0000.md', 'NUL 바이트'],
  ['제목\u200B숨김', 'zero-width 문자'],
  ['\u202Eexe.txt', 'BiDi 확장자 위장'],
  ['a'.repeat(300), '초장문 제목'],
  ['....', '마침표만'],
  ['   ', '공백만'],
  ['에이콤(주) 계약', '정상 한국어'],
  ['ACME Corp. — 2026 Q1', '정상 영문'],
];

console.log('\n=== M0 보강 · sanitizeTitle 검증 ===\n');
let inside = 0;
let blocked = 0;
let escaped = 0;
for (const [title, label] of ATTACKS) {
  const shown = JSON.stringify(title).slice(0, 42);
  try {
    const p = safeJoin(VAULT, '02_NOTES/entities', title);
    const ok = p.startsWith('/vault/02_NOTES/entities/');
    if (ok) inside++;
    else escaped++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(16)} ${shown.padEnd(44)} → ${p.replace('/vault/02_NOTES/entities/', '')}`);
  } catch (e) {
    blocked++;
    console.log(`  차단 ${label.padEnd(16)} ${shown.padEnd(44)} → ${e.message}`);
  }
}
console.log(`\n  ${ATTACKS.length}건 중 안전 정규화 ${inside}건, 예외 차단 ${blocked}건, 탈출 성공 ${escaped}건`);
console.log(`  ${escaped === 0 ? 'PASS — Vault 밖으로 나가는 경로 없음' : 'FAIL — 탈출 발생'}`);
