// 3-pane 셸. DESIGN-SYSTEM.md 의 토큰만 쓴다.
// 좌: 원본 목록 / 중: 검색 결과 / 우: 원문 뷰어 (앵커로 점프)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Extraction, SearchHit } from '../core/types.ts';
import type { SbApi, IngestResult, SourceSummary } from '../main/ipc.ts';
import type { VaultConfig } from '../core/vault.ts';
import type { Review } from '../core/review.ts';
import type { Status } from '../core/spend.ts';
import type { Answer } from '../core/query.ts';
import type { JudgmentFinding, ParsedJudgment } from '../core/lint/judgment.ts';
import { JUDGMENT_NAMES } from '../core/lint/judgment.ts';
import type { ScanEstimate } from '../core/tokens.ts';
import { summarizeScan } from '../core/tokens.ts';
import { summarize } from '../core/spend.ts';
import ReviewOverlay from './Review.tsx';

declare global {
  interface Window {
    sb: SbApi;
  }
}

const MIN_QUERY_LEN = 2; // core/search.ts 와 같은 값. 1자는 오검색만 낸다.

export default function App() {
  const [vault, setVault] = useState<VaultConfig | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<{ ext: Extraction; locator: string | null } | null>(null);
  const [report, setReport] = useState<IngestResult | null>(null);
  // 변경안은 승인 전까지 여기(그리고 main 의 메모리)에만 있다. 디스크에는 없다.
  const [review, setReview] = useState<Review | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [spend, setSpend] = useState<Status[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  // 답변도 디스크에 바로 안 쓴다. 보관을 눌러야 검토 화면으로 간다.
  const [answer, setAnswer] = useState<{ question: string; answer: Answer } | null>(null);
  // 전수 검사는 돈이 든다. 예상 비용을 보여주고 확인받은 뒤에 돈다 (M2-PLAN.md §3.3)
  const [estimate, setEstimate] = useState<ScanEstimate | null>(null);
  const [judgment, setJudgment] = useState<ParsedJudgment | null>(null);

  useEffect(() => {
    void window.sb.currentVault().then(setVault);
  }, []);

  const refresh = useCallback(async () => {
    setSources(await window.sb.listSources());
    setSpend(await window.sb.spendStatus());
    setPending((await window.sb.plan()).fresh.length);
  }, []);

  useEffect(() => {
    if (vault) void refresh();
  }, [vault, refresh]);

  // 질의가 짧으면 아예 보내지 않는다 (core 도 거부하지만 왕복을 아낀다)
  useEffect(() => {
    const q = query.trim();
    if ([...q].length < MIN_QUERY_LEN) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void window.sb.search(q).then((r) => live && setHits(r));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const openVault = async (mode: 'open' | 'create') => {
    setBusy(true);
    try {
      const v = await window.sb.pickVault(mode);
      if (v) {
        setVault(v);
        setViewer(null);
        setHits([]);
      }
    } finally {
      setBusy(false);
    }
  };

  const ingest = async () => {
    setBusy(true);
    try {
      const r = await window.sb.pickAndIngest();
      setReport(r);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const propose = async (sourceId: string) => {
    setBusy(true);
    setReviewNote(null);
    try {
      const r = await window.sb.propose(sourceId);
      if (r.ok) {
        setReview(r.review);
        setReviewNote(`이번 제안에 $${r.costUsd.toFixed(4)} 들었습니다`);
      } else {
        setReviewNote(r.error);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const applyReview = async (approved: string[]) => {
    setBusy(true);
    try {
      const res = await window.sb.applyReview(approved);
      if (res.applied.length > 0) {
        setReview(null);
        setReviewNote(`${res.applied.length}건 적용했습니다`);
      } else {
        // 관문 7 은 적용 직전에 다시 본다. 검토 중에 파일이 바뀌었을 수 있다.
        setReviewNote(res.conflicts.length ? '검토하는 동안 페이지가 바뀌었습니다. 다시 제안해 주십시오' : '적용하지 못했습니다');
      }
    } finally {
      setBusy(false);
    }
  };

  const discardReview = async () => {
    await window.sb.discardReview();
    setReview(null);
    setReviewNote(null);
  };

  const ask = async (question: string) => {
    setBusy(true);
    setReviewNote(null);
    setAnswer(null);
    try {
      const r = await window.sb.ask(question);
      if (r.ok) {
        setAnswer({ question: r.question, answer: r.answer });
        setReviewNote(`이번 질의에 $${r.costUsd.toFixed(4)} 들었습니다`);
      } else {
        setReviewNote(r.error);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!answer) return;
    setBusy(true);
    try {
      setReview(await window.sb.archiveAnswer(answer.question, answer.answer));
      setAnswer(null);
    } finally {
      setBusy(false);
    }
  };

  const runJudgment = async () => {
    setBusy(true);
    setJudgment(null);
    setEstimate(null);
    try {
      const r = await window.sb.lintJudgment();
      if (r.ok) {
        setJudgment(r.result);
        setReviewNote(`판단 검사에 $${r.costUsd.toFixed(4)} 들었습니다`);
      } else {
        setReviewNote(r.error);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const exportDeck = async () => {
    setBusy(true);
    try {
      const p = await window.sb.exportDeck();
      setReviewNote(p ? `슬라이드를 저장했습니다: ${p}` : null);
    } finally {
      setBusy(false);
    }
  };

  const jump = async (sourceId: string, locator: string | null) => {
    const ext = await window.sb.readSource(sourceId);
    if (ext) setViewer({ ext, locator });
  };

  if (!vault) return <Welcome onPick={openVault} busy={busy} />;

  return (
    <div style={S.shell}>
      <Rail
        vault={vault}
        sources={sources}
        busy={busy}
        onIngest={ingest}
        onOpen={() => openVault('open')}
        onSelect={(id) => jump(id, null)}
        spend={spend}
        pending={pending}
        onLint={async () => setEstimate(await window.sb.estimateJudgment())}
        onExport={exportDeck}
      />
      <Results
        query={query}
        setQuery={setQuery}
        hits={hits}
        onJump={jump}
        sourceCount={sources.length}
        busy={busy}
        answer={answer}
        onAsk={ask}
        onArchive={archive}
        estimate={estimate}
        judgment={judgment}
        onRunLint={runJudgment}
        onCancelLint={() => setEstimate(null)}
      />
      <Viewer viewer={viewer} busy={busy} note={reviewNote} onPropose={propose} />
      {report && <ReportToast report={report} onClose={() => setReport(null)} />}
      {review && (
        <ReviewOverlay
          review={review}
          busy={busy}
          onApply={applyReview}
          onCancel={discardReview}
          onJump={(sourceId, locator) => void jump(sourceId, locator)}
        />
      )}
    </div>
  );
}

/* ---------- 첫 화면 ---------- */

function Welcome({ onPick, busy }: { onPick: (m: 'open' | 'create') => void; busy: boolean }) {
  return (
    <div style={S.welcome} className="enter">
      <div style={{ maxWidth: 460 }}>
        <h1 style={S.h1}>co-secondbrain</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
          프로젝트 문서를 넣으면 원문 위치까지 찾아 주는 개인 금고입니다.
          이 단계에서는 LLM 을 쓰지 않고 전부 로컬에서 처리합니다.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s)', marginTop: 24 }}>
          <button className="primary" disabled={busy} onClick={() => onPick('create')}>
            새 Vault 만들기
          </button>
          <button disabled={busy} onClick={() => onPick('open')}>
            기존 Vault 열기
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 좌: 원본 목록 ---------- */

function Rail({
  vault,
  sources,
  busy,
  onIngest,
  onOpen,
  onSelect,
  spend,
  pending,
  onLint,
  onExport,
}: {
  vault: VaultConfig;
  sources: SourceSummary[];
  busy: boolean;
  onIngest: () => void;
  onOpen: () => void;
  onSelect: (id: string) => void;
  spend: Status[];
  pending: number | null;
  onLint: () => void;
  onExport: () => void;
}) {
  // 개인 금고와 CO 영역을 색·아이콘·접두로 구분한다 (DESIGN-SYSTEM.md)
  const isCo = vault.hub !== null;
  return (
    <aside style={{ ...S.rail, background: isCo ? 'var(--bg-surface)' : 'var(--bg-canvas)' }}>
      <div style={{ ...S.railHead, borderBottomColor: isCo ? 'var(--info)' : 'var(--border)' }}>
        <div style={S.vaultName}>
          <span style={S.lock}>{isCo ? '[CO]' : '[개인]'}</span> {vault.title}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button className="primary" style={{ flex: 1 }} disabled={busy} onClick={onIngest}>
            문서 추가
          </button>
          <button disabled={busy} onClick={onOpen} title="다른 Vault 열기">
            …
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button style={{ flex: 1 }} disabled={busy} onClick={onLint} title="LLM 판단 검사 4종">
            판단 검사
          </button>
          <button style={{ flex: 1 }} disabled={busy} onClick={onExport} title="Marp 슬라이드로 내보내기">
            슬라이드
          </button>
        </div>
      </div>

      <div style={S.railBody}>
        <div style={S.sectionLabel}>
          원본 {sources.length}건{pending !== null && pending > 0 ? ` · 제안 대기 ${pending}건` : ''}
        </div>
        {busy && sources.length === 0 && (
          <div style={{ padding: 'var(--s)' }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 32, marginBottom: 6 }} />
            ))}
          </div>
        )}
        {sources.map((s) => (
          <button key={s.sourceId} style={S.sourceRow} onClick={() => onSelect(s.sourceId)}>
            <span style={S.kindTag}>{s.kind}</span>
            <span style={S.sourceName}>{s.filename}</span>
            <span style={S.chunkCount}>{s.chunks}</span>
          </button>
        ))}
        {!busy && sources.length === 0 && (
          <div style={S.empty}>
            아직 문서가 없습니다.
            <br />
            <span style={{ color: 'var(--fg-faint)' }}>docx · xlsx · pptx · pdf · eml · vtt · md</span>
          </div>
        )}
      </div>

      {/* 달러가 아니라 남은 문서 수를 먼저 보여준다 (M2-PLAN.md §3.4) */}
      <div style={S.spendBar}>
        {spend.map((s) => (
          <div key={s.provider} style={{ color: s.level === 'over' ? 'var(--danger)' : s.level === 'warn' ? 'var(--warn)' : 'var(--fg-faint)' }}>
            {summarize(s)}
          </div>
        ))}
      </div>
    </aside>
  );
}

/* ---------- 중: 검색 ---------- */

function Results({
  query,
  setQuery,
  hits,
  onJump,
  sourceCount,
  busy,
  answer,
  onAsk,
  onArchive,
  estimate,
  judgment,
  onRunLint,
  onCancelLint,
}: {
  query: string;
  setQuery: (q: string) => void;
  hits: SearchHit[];
  onJump: (sourceId: string, locator: string) => void;
  sourceCount: number;
  busy: boolean;
  answer: { question: string; answer: Answer } | null;
  onAsk: (q: string) => void;
  onArchive: () => void;
  estimate: ScanEstimate | null;
  judgment: ParsedJudgment | null;
  onRunLint: () => void;
  onCancelLint: () => void;
}) {
  const len = [...query.trim()].length;
  const tooShort = len === 1;
  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const list = m.get(h.sourceId) ?? [];
      list.push(h);
      m.set(h.sourceId, list);
    }
    return [...m.entries()];
  }, [hits]);

  return (
    <main style={S.center}>
      <div style={S.searchBar}>
        <input
          type="search"
          value={query}
          placeholder="검색 (2자 이상)"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="검색"
        />
        {tooShort && <div style={S.hintWarn}>2자 이상 입력해 주세요. 1자 질의는 결과가 너무 많습니다.</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <button disabled={busy || len < 2} onClick={() => onAsk(query.trim())}>
            위키에 묻기
          </button>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-faint)' }}>
            검색은 원본을, 질의는 위키를 봅니다
          </span>
        </div>
      </div>

      {answer && <AnswerCard entry={answer} busy={busy} onJump={onJump} onArchive={onArchive} />}
      {estimate && <EstimateBar estimate={estimate} busy={busy} onRun={onRunLint} onCancel={onCancelLint} />}
      {judgment && <JudgmentList result={judgment} />}

      <div style={S.resultBody}>
        {len >= 2 && hits.length === 0 && <div style={S.empty}>결과가 없습니다.</div>}
        {len < 2 && !tooShort && (
          <div style={S.empty}>
            원본 {sourceCount}건이 색인돼 있습니다.
            <br />
            <span style={{ color: 'var(--fg-faint)' }}>조사가 붙은 어절도 찾습니다 — “갱신일”로 “갱신일은”이 걸립니다</span>
          </div>
        )}
        {grouped.map(([sourceId, list]) => (
          <section key={sourceId} className="enter" style={S.hitGroup}>
            <div style={S.hitGroupHead}>{sourceId}</div>
            {list.map((h, i) => (
              <button key={`${h.locator}-${i}`} style={S.hitRow} onClick={() => onJump(h.sourceId, h.locator)}>
                <span style={S.anchorChip}>{h.label}</span>
                <span style={S.snippet}>{h.snippet}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}

/* ---------- 질의 답변 ---------- */

function AnswerCard({
  entry,
  busy,
  onJump,
  onArchive,
}: {
  entry: { question: string; answer: Answer };
  busy: boolean;
  onJump: (sourceId: string, locator: string) => void;
  onArchive: () => void;
}) {
  const { answer } = entry;
  return (
    <section style={S.answer} className="enter">
      <div style={S.answerQ}>{entry.question}</div>
      <div style={{ marginTop: 6 }}>{answer.answer}</div>

      <ul style={S.claims}>
        {answer.claims.map((c, i) => {
          const [sourceId, ...rest] = c.source.split('#');
          const locator = rest.join('#');
          return (
            <li key={i} style={S.claim}>
              <button style={S.chip} title="원문으로 이동" onClick={() => onJump(sourceId!, locator)}>
                {c.source}
              </button>
              <span style={{ color: 'var(--fg-muted)' }}>{c.text}</span>
            </li>
          );
        })}
      </ul>

      <button className="primary" style={{ marginTop: 10 }} disabled={busy} onClick={onArchive}>
        위키에 보관
      </button>
    </section>
  );
}

/* ---------- 판단 검사 ---------- */

function EstimateBar({
  estimate,
  busy,
  onRun,
  onCancel,
}: {
  estimate: ScanEstimate;
  busy: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={S.estimate} className="enter">
      <span>{summarizeScan(estimate)}</span>
      <span style={{ flex: 1 }} />
      <button disabled={busy} onClick={onCancel}>
        취소
      </button>
      <button className="primary" disabled={busy} onClick={onRun}>
        검사 실행
      </button>
    </div>
  );
}

function JudgmentList({ result }: { result: ParsedJudgment }) {
  if (result.findings.length === 0) {
    return (
      <div style={S.empty}>
        판단 검사에서 지적이 없습니다.
        {result.dropped > 0 && <div style={{ color: 'var(--warn)' }}>버린 지적 {result.dropped}건</div>}
      </div>
    );
  }
  return (
    <section style={{ padding: 'var(--s)' }} className="enter">
      {result.dropped > 0 && (
        <div style={{ ...S.hintWarn, marginBottom: 6 }}>
          없는 페이지를 가리켜 버린 지적 {result.dropped}건
        </div>
      )}
      {result.findings.map((f: JudgmentFinding, i) => (
        <div key={i} style={S.finding}>
          <div style={S.findingHead}>{JUDGMENT_NAMES[f.check]}</div>
          <div>{f.message}</div>
          <div style={{ color: 'var(--fg-muted)', fontSize: '0.8125rem', marginTop: 4 }}>{f.fix}</div>
          <div style={{ marginTop: 4 }}>
            {f.pages.map((p) => (
              <span key={p} style={S.path}>
                {p}{' '}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ---------- 우: 원문 뷰어 ---------- */

function Viewer({
  viewer,
  busy,
  note,
  onPropose,
}: {
  viewer: { ext: Extraction; locator: string | null } | null;
  busy: boolean;
  note: string | null;
  onPropose: (sourceId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!viewer?.locator) return;
    ref.current?.querySelector(`[data-locator="${CSS.escape(viewer.locator)}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [viewer]);

  if (!viewer) {
    return (
      <aside style={S.viewer}>
        <div style={S.empty}>검색 결과나 원본을 고르면 여기에 원문이 열립니다.</div>
      </aside>
    );
  }

  const { ext, locator } = viewer;
  return (
    <aside style={S.viewer} ref={ref}>
      <div style={S.viewerHead}>
        <div style={{ fontWeight: 600 }}>{ext.filename}</div>
        <div style={S.viewerMeta}>
          {ext.kind} · {ext.chunks.length}개 조각 · 관계 {ext.relations.length}개
        </div>
        <div style={{ display: 'flex', gap: 'var(--s)', alignItems: 'center', marginTop: 8 }}>
          <button disabled={busy} onClick={() => onPropose(ext.sourceId)}>
            이 원본으로 위키 갱신
          </button>
          {busy && <span className="skeleton" style={{ flex: 1, height: 14 }} />}
        </div>
        {note && <div style={S.viewerNote}>{note}</div>}
        {ext.warnings.map((w, i) => (
          <div key={i} style={S.warnBox}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ padding: 'var(--s)' }}>
        {ext.chunks.map((c, i) => {
          const active = c.anchor.locator === locator;
          return (
            <div
              key={`${c.anchor.locator}-${i}`}
              data-locator={c.anchor.locator}
              style={{
                ...S.chunk,
                borderColor: active ? 'var(--info)' : 'var(--border)',
                background: active ? '#0d1520' : 'var(--bg-raised)',
              }}
            >
              <div style={S.chunkAnchor}>{c.anchor.label}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ---------- 인제스트 결과 ---------- */

function ReportToast({ report, onClose }: { report: IngestResult; onClose: () => void }) {
  const { ok, failed, warnings, relations } = report;
  return (
    <div style={S.toast} className="enter">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {ok.length}건 처리 · 구조 관계 {relations}개
      </div>
      {warnings.map((w, i) => (
        <div key={i} style={{ color: 'var(--warn)', fontSize: '0.875rem' }}>
          {w.filename}: {w.warning}
        </div>
      ))}
      {failed.map((x, i) => (
        <div key={i} style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>
          {x.filename}: {x.reason}
        </div>
      ))}
      <button style={{ marginTop: 10 }} onClick={onClose}>
        닫기
      </button>
    </div>
  );
}

/* ---------- 스타일 ---------- */

const S = {
  shell: { display: 'grid', gridTemplateColumns: '280px 1fr 420px', height: '100dvh' },
  welcome: { display: 'grid', placeItems: 'center', height: '100dvh', padding: 24 },
  h1: { fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.06em', margin: '0 0 8px' },

  rail: { borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  railHead: { padding: 'var(--s)', borderBottom: '1px solid var(--border)' },
  vaultName: { fontWeight: 600, fontSize: '0.9375rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  lock: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-muted)' },
  railBody: { overflowY: 'auto', flex: 1 },
  sectionLabel: { padding: '10px var(--s) 4px', fontSize: '0.8125rem', color: 'var(--fg-muted)', fontWeight: 500 },
  sourceRow: {
    display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 6, alignItems: 'center',
    width: '100%', textAlign: 'left', border: 'none', borderRadius: 0, padding: '6px var(--s)', background: 'transparent',
  },
  kindTag: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', color: 'var(--fg-faint)', width: 34 },
  sourceName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.875rem' },
  chunkCount: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },
  spendBar: { borderTop: '1px solid var(--border)', padding: '6px var(--s)', fontSize: '0.75rem', fontFamily: 'var(--mono)' },

  center: { display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' },
  searchBar: { padding: 'var(--s)', borderBottom: '1px solid var(--border)' },
  hintWarn: { color: 'var(--warn)', fontSize: '0.8125rem', marginTop: 6 },
  resultBody: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },
  answer: {
    margin: 'var(--s)', padding: 'var(--s)', background: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)',
  },
  answerQ: { fontWeight: 600, fontSize: '0.875rem', color: 'var(--fg-muted)' },
  claims: { listStyle: 'none', margin: '10px 0 0', padding: 0, fontSize: '0.875rem' },
  claim: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 },
  chip: {
    fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)',
    border: '1px solid var(--border)', padding: '1px 6px', background: 'transparent', whiteSpace: 'nowrap',
  },
  estimate: {
    display: 'flex', gap: 6, alignItems: 'center', margin: 'var(--s)', padding: 'var(--s)',
    border: '1px solid var(--warn)', borderRadius: 'var(--r-card)', fontSize: '0.8125rem',
  },
  finding: {
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)',
    padding: 'var(--s)', marginBottom: 6, fontSize: '0.875rem',
  },
  findingHead: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--warn)', marginBottom: 4 },
  path: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },
  hitGroup: { marginBottom: 16 },
  hitGroupHead: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: 4 },
  hitRow: {
    display: 'block', width: '100%', textAlign: 'left', background: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s)', marginBottom: 6,
  },
  anchorChip: {
    display: 'inline-block', fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)',
    marginRight: 8, whiteSpace: 'nowrap',
  },
  snippet: { fontSize: '0.875rem', color: 'var(--fg-muted)' },

  viewer: { borderLeft: '1px solid var(--border)', overflowY: 'auto', background: 'var(--bg-surface)' },
  viewerHead: { padding: 'var(--s)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-surface)' },
  viewerMeta: { fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  viewerNote: { marginTop: 8, fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  warnBox: {
    marginTop: 6, padding: 6, borderRadius: 'var(--r-input)',
    border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '0.8125rem',
  },
  chunk: { border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s)', marginBottom: 6, transition: 'background 200ms ease-out' },
  chunkAnchor: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', marginBottom: 4 },

  empty: { padding: 24, color: 'var(--fg-muted)', textAlign: 'center', fontSize: '0.875rem' },
  toast: {
    position: 'fixed', right: 16, bottom: 16, maxWidth: 420,
    background: 'var(--bg-raised)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-card)', padding: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.6)',
  },
} satisfies Record<string, React.CSSProperties>;
