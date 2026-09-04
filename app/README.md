# app — co-secondbrain (M1)

개인 금고. **LLM 을 쓰지 않는다** — 텍스트·구조 추출과 검색이 전부 로컬이다.

```bash
npm install
npm run check      # typecheck + test  (39/39)
npm run build      # main(tsc) + renderer(vite)
npm run dev        # 렌더러만 (Electron 은 Windows/mac 에서)
```

**이 환경(Linux 컨테이너)에서 검증한 것:** 타입 검사, 테스트 39건, main·렌더러 빌드,
빌드 산출물 로드. **검증하지 못한 것:** 실제 창이 뜨는 모습, 한글 폰트 렌더링,
Windows 경로 처리 — 사내 PC에서 확인해야 합니다.

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

## 구현 중 걸린 것

- **TypeScript 파라미터 프로퍼티**(`constructor(private x: T)`)는 Node 의 타입 제거가
  처리하지 못한다 (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). 명시 필드로 쓴다
- **동기 화살표 함수 안의 `await`** 도 같은 이유로 실패한다
- `.ts` 확장자 임포트가 Node 타입 제거(요구)와 `tsc` 방출(금지) 사이에서 충돌한다.
  `rewriteRelativeImportExtensions`(TS 5.7)로 소스는 `.ts`, 방출은 `.js` 로 간다
- `@kenjiuno/msgreader` 는 CJS/ESM interop 때문에 `default` 가 한 겹 더 감싸일 수 있다
