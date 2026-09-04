# app — co-secondbrain (M1)

개인 금고. **LLM 을 쓰지 않는다** — 텍스트·구조 추출과 검색이 전부 로컬이다.

```bash
npm install
npm run check      # typecheck + test
```

## 구조

```
src/core/          순수 TS. Electron 무관. 여기가 테스트 대상
├─ types.ts        Anchor · Chunk · Relation · Extraction
├─ security.ts     slugify · safeJoin — 경로 탈출 방어 (M0 14/14)
├─ search.ts       한국어 하이브리드 검색 (M0 §11, 재현율·정밀도 1.000)
├─ vault.ts        Vault 생성·열기·log.md
└─ extract/        docx xlsx pptx pdf eml/msg vtt/srt txt/md
src/main/          Electron main + IPC
src/renderer/      React UI
test/              node:test. 픽스처는 ../spikes/fixtures/files
```

## 설계 근거

`core/` 를 Electron 과 분리한 이유는 **여기가 Linux 컨테이너이고 GUI 를 띄울 수 없기**
때문이다. 로직 전부를 헤드리스로 검증하고, Electron 은 얇은 껍데기로 둔다.

`search.ts` 의 `Db` 인터페이스는 과설계가 아니다. Electron 이 `node:sqlite`(실험적)를
노출하는지 확인되지 않아 `better-sqlite3` 로 갈 수도 있다. 둘 다 만족하는 최소 형태다.
