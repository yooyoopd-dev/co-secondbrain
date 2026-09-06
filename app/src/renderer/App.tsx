// 3-pane 셸. DESIGN-SYSTEM.md 의 토큰만 쓴다.
// 좌: 원본 목록 / 중: 검색 결과 / 우: 원문 뷰어 (앵커로 점프)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Extraction, SearchHit } from '../core/types.ts';
import type { SbApi, AppSettings, HubStatus, InboxItem, IngestResult, SourceSummary } from '../main/ipc.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { EMPTY_CORE_CONTEXT, type CoreContext } from '../core/context.ts';
import { CLASSIFICATIONS, CLASSIFICATION_LABEL, DEFAULT_CLASSIFICATION } from '../core/types.ts';
import type { Classification } from '../core/types.ts';
import type { LogEntry } from '../core/log.ts';
import type { SyncConflict, SyncReport } from '../core/sync/index.ts';
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
import SyncPanel from './Sync.tsx';
import DebugPanel from './Debug.tsx';
import { CoreContextPanel, SettingsPanel } from './Settings.tsx';
import { Icon } from './icons.tsx';

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
  // 동기화. 충돌은 main 의 메모리에만 있고 디스크에는 없다 (HUB.md §5)
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // 오류 기록. main 의 버퍼가 원본이고 화면은 사본을 그린다 (core/log.ts)
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errors, setErrors] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  // 넣을 때 고르는 열람 등급. 기본은 사내다 — 공개를 기본으로 두면 실수가 유출이 된다
  const [classification, setClassification] = useState<Classification>(DEFAULT_CLASSIFICATION);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  // 설정과 내 맥락. 정본은 main(과 Vault 의 파일)이고 화면은 사본을 그린다
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [core, setCore] = useState<CoreContext>(EMPTY_CORE_CONTEXT);
  const [coreOpen, setCoreOpen] = useState(false);

  useEffect(() => {
    void window.sb.currentVault().then(setVault);
  }, []);

  const pullLogs = useCallback(async () => {
    const s = await window.sb.logs();
    setLogs(s.entries);
    setErrors(s.errors);
  }, []);

  // Vault 를 열기 전에 난 오류도 세어 둔다. 첫 화면에서 사유를 볼 수 있어야 한다.
  useEffect(() => {
    void pullLogs();
  }, [pullLogs]);

  const refresh = useCallback(async () => {
    setSources(await window.sb.listSources());
    setSpend(await window.sb.spendStatus());
    setPending((await window.sb.plan()).fresh.length);
    setHub(await window.sb.hubStatus());
    setInbox(await window.sb.inbox());
    await pullLogs();
  }, [pullLogs]);

  // 창을 안 건드려도 나는 오류가 있다. 패널이 열려 있는 동안만 다시 읽는다.
  useEffect(() => {
    if (!debugOpen) return;
    const t = setInterval(() => void pullLogs(), 3000);
    return () => clearInterval(t);
  }, [debugOpen, pullLogs]);

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

  const ingest = async (from: 'pick' | 'inbox') => {
    setBusy(true);
    try {
      const r = from === 'pick' ? await window.sb.pickAndIngest(classification) : await window.sb.ingestInbox(classification);
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

  // 고친 내용은 관문을 다시 통과해야 한다. main 이 재검사한 결과로 화면을 갈아 끼운다.
  const editOp = async (path: string, content: string) => {
    setBusy(true);
    try {
      setReview(await window.sb.editOp(path, content));
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

  /* 동기화 — 받기·보내기는 main 이 하고 화면은 결과와 충돌만 그린다 */

  const openSync = async () => {
    setSyncNote(null);
    setConflicts(await window.sb.conflicts());
    setSyncOpen(true);
  };

  const connectHub = async (url: string, token: string) => {
    setBusy(true);
    try {
      const r = await window.sb.connectHub(url, token);
      setSyncNote(r.ok ? `연결했습니다 (권한 ${r.role})` : r.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const disconnectHub = async () => {
    setBusy(true);
    try {
      await window.sb.disconnectHub();
      setConflicts([]);
      setSyncReport(null);
      setSyncNote('연결을 끊었습니다. 받아 둔 페이지는 그대로 남습니다');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    setSyncNote(null);
    try {
      const r = await window.sb.syncNow();
      if (r.ok) {
        setSyncReport(r.report);
        setConflicts(r.report.conflicts);
        if (r.report.conflicts.length > 0) setSyncNote(`충돌 ${r.report.conflicts.length}건을 병합해 주십시오`);
      } else {
        setSyncNote(r.error);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (pageId: string, merged: string) => {
    setBusy(true);
    try {
      const r = await window.sb.resolveConflict(pageId, merged);
      if (r.conflicts) setConflicts(r.conflicts);
      setSyncNote(r.ok ? `올렸습니다 (v${r.version})` : r.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const jump = async (sourceId: string, locator: string | null) => {
    const ext = await window.sb.readSource(sourceId);
    if (ext) setViewer({ ext, locator });
  };

  /* 설정 · 내 맥락 */

  const openSettings = async () => setSettings(await window.sb.settings());

  const pickProvider = async (id: ProviderId | null) => {
    await window.sb.setProvider(id);
    setSettings(await window.sb.settings());
  };

  /**
   * Vault 를 닫고 첫 화면으로 돌아간다. **검토 대기가 있으면 먼저 묻는다** —
   * 승인 전 변경안은 main 의 메모리에만 있어서 닫는 순간 사라진다.
   */
  const closeVault = async () => {
    if (review && !window.confirm('검토 중인 변경안이 사라집니다. 그래도 닫습니까?')) return;
    await window.sb.closeVault();
    setSettings(null);
    setVault(null);
    setSources([]);
    setHits([]);
    setQuery('');
    setViewer(null);
    setReview(null);
    setReviewNote(null);
    setAnswer(null);
    setInbox([]);
    setCore(EMPTY_CORE_CONTEXT);
  };

  /** 앱을 끝낸다. 승인 전 변경안은 메모리에만 있으므로 여기서도 먼저 묻는다 */
  const quit = async () => {
    if (review && !window.confirm('검토 중인 변경안이 사라집니다. 그래도 끝냅니까?')) return;
    await window.sb.quit();
  };

  // 설정에서 넘어올 때는 설정을 먼저 닫는다. 겹침 화면을 쌓으면 닫는 순서가 헷갈린다.
  const openCore = async () => {
    setCore(await window.sb.coreContext());
    setCoreOpen(true);
  };

  const saveCore = async (ctx: CoreContext) => {
    setBusy(true);
    try {
      await window.sb.setCoreContext(ctx);
      setCore(await window.sb.coreContext());
      setReviewNote('내 맥락을 저장했습니다');
    } finally {
      setBusy(false);
    }
  };

  /* 오류 기록 — 복사·저장은 main 이 한다. 렌더러는 클립보드에 직접 닿지 않는다 */

  const debug = {
    open: async () => {
      await pullLogs();
      setDebugOpen(true);
    },
    copy: async () => {
      const n = await window.sb.copyLogs();
      setReviewNote(`${n}줄을 클립보드에 넣었습니다`);
    },
    save: async () => {
      const p = await window.sb.saveLogs();
      if (p) setReviewNote('오류 기록을 저장했습니다');
    },
    clear: async () => {
      await window.sb.clearLogs();
      await pullLogs();
    },
  };

  // 첫 화면에서도 열 수 있어야 한다. Vault 를 못 여는 것 자체가 흔한 실패다.
  const debugOverlay = debugOpen && (
    <DebugPanel
      entries={logs}
      busy={busy}
      onCopy={() => void debug.copy()}
      onSave={() => void debug.save()}
      onClear={() => void debug.clear()}
      onClose={() => setDebugOpen(false)}
    />
  );

  if (!vault) {
    return (
      <>
        <Welcome onPick={openVault} busy={busy} errors={errors} onDebug={() => void debug.open()} />
        {debugOverlay}
      </>
    );
  }

  return (
    <div style={S.shell}>
      <Rail
        vault={vault}
        sources={sources}
        busy={busy}
        onIngest={() => void ingest('pick')}
        onInbox={() => void ingest('inbox')}
        inbox={inbox}
        classification={classification}
        onClassification={setClassification}
        onSettings={() => void openSettings()}
        onCloseVault={() => void closeVault()}
        onQuit={() => void quit()}
        onSelect={(id) => jump(id, null)}
        spend={spend}
        pending={pending}
        onLint={async () => setEstimate(await window.sb.estimateJudgment())}
        onExport={exportDeck}
        hub={hub}
        onSync={openSync}
        errors={errors}
        onDebug={() => void debug.open()}
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
      {syncOpen && hub && (
        <SyncPanel
          status={hub}
          conflicts={conflicts}
          report={syncReport}
          busy={busy}
          note={syncNote}
          onConnect={(url, token) => void connectHub(url, token)}
          onDisconnect={() => void disconnectHub()}
          onSync={() => void syncNow()}
          onResolve={(pageId, merged) => void resolve(pageId, merged)}
          onClose={() => setSyncOpen(false)}
        />
      )}
      {review && (
        <ReviewOverlay
          review={review}
          busy={busy}
          onApply={applyReview}
          onCancel={discardReview}
          onJump={(sourceId, locator) => void jump(sourceId, locator)}
          onEdit={(path, content) => void editOp(path, content)}
        />
      )}
      {settings && (
        <SettingsPanel
          settings={settings}
          hub={hub}
          busy={busy}
          onProvider={(id) => void pickProvider(id)}
          onCore={() => {
            setSettings(null);
            void openCore();
          }}
          onHub={() => {
            setSettings(null);
            void openSync();
          }}
          onClose={() => setSettings(null)}
        />
      )}
      {coreOpen && (
        <CoreContextPanel value={core} busy={busy} onSave={(c) => void saveCore(c)} onClose={() => setCoreOpen(false)} />
      )}
      {debugOverlay}
    </div>
  );
}

/* ---------- 첫 화면 ---------- */

function Welcome({
  onPick,
  busy,
  errors,
  onDebug,
}: {
  onPick: (m: 'open' | 'create') => void;
  busy: boolean;
  errors: number;
  onDebug: () => void;
}) {
  return (
    <div style={S.welcome}>
      <div style={{ maxWidth: 460 }} className="stagger">
        <img src="./icon-256.png" width={72} height={72} alt="" style={S.mark} />
        <h1 style={S.h1}>co-secondbrain</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
          프로젝트 문서를 넣으면 원문 위치까지 찾아 주는 개인 Vault 입니다.
          이 단계에서는 LLM 을 쓰지 않고 전부 로컬에서 처리합니다.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s)', marginTop: 24, alignItems: 'center' }}>
          <button className="primary" disabled={busy} onClick={() => onPick('create')}>
            새 Vault 만들기
          </button>
          <button disabled={busy} onClick={() => onPick('open')}>
            기존 Vault 열기
          </button>
          <ErrorButton errors={errors} onClick={onDebug} />
        </div>
      </div>
    </div>
  );
}

/** 오류가 없으면 눈에 띄지 않아야 한다. 상시 빨간 배지는 곧 무시된다. */
function ErrorButton({ errors, onClick, style }: { errors: number; onClick: () => void; style?: React.CSSProperties }) {
  const has = errors > 0;
  return (
    <button
      onClick={onClick}
      title="오류 기록을 열고 복사합니다"
      style={{
        fontSize: '0.8125rem',
        padding: '4px 10px',
        ...(has ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : { borderColor: 'var(--border)', color: 'var(--fg-faint)' }),
        ...style,
      }}
    >
      <Icon name="alert" size={14} />
      {has ? `오류 ${errors}` : '오류 기록'}
    </button>
  );
}

/* ---------- 좌: 원본 목록 ---------- */

function Rail({
  vault,
  sources,
  busy,
  onIngest,
  onInbox,
  inbox,
  classification,
  onClassification,
  onSettings,
  onCloseVault,
  onQuit,
  onSelect,
  spend,
  pending,
  onLint,
  onExport,
  hub,
  onSync,
  errors,
  onDebug,
}: {
  vault: VaultConfig;
  sources: SourceSummary[];
  busy: boolean;
  onIngest: () => void;
  onInbox: () => void;
  inbox: InboxItem[];
  classification: Classification;
  onClassification: (c: Classification) => void;
  onSettings: () => void;
  onCloseVault: () => void;
  onQuit: () => void;
  onSelect: (id: string) => void;
  spend: Status[];
  pending: number | null;
  onLint: () => void;
  onExport: () => void;
  hub: HubStatus | null;
  onSync: () => void;
  errors: number;
  onDebug: () => void;
}) {
  // 개인 Vault 와 CO 영역을 색·아이콘·접두로 구분한다 (DESIGN-SYSTEM.md)
  const isCo = vault.hub !== null;
  return (
    <aside style={{ ...S.rail, background: isCo ? 'var(--bg-surface)' : 'var(--bg-canvas)' }}>
      <div style={{ ...S.railHead, borderBottomColor: isCo ? 'var(--info)' : 'var(--border)' }}>
        <div style={S.vaultName}>
          {/* 색 하나로 공간을 구분하지 않는다. 아이콘과 접두 텍스트를 같이 쓴다 */}
          <span style={S.lock} title={isCo ? 'CO 공간' : '개인 Vault'}>
            <Icon name={isCo ? 'users' : 'lock'} size={14} />
            {isCo ? 'CO' : '개인'}
          </span>
          {vault.title}
        </div>
        {/* 넣기 전에 등급을 고른다. 넣고 나서 고치게 하면 아무도 안 고친다 */}
        <label style={S.classField}>
          <span style={S.classLabel}>넣을 자료의 열람 등급</span>
          <select
            value={classification}
            disabled={busy}
            aria-label="열람 등급"
            onChange={(e) => onClassification(e.target.value as Classification)}
            style={S.select}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {CLASSIFICATION_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="primary" style={{ flex: 1 }} disabled={busy} onClick={onIngest}>
            <Icon name="plus" /> 문서 추가
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
        {/* 충돌은 사람이 먼저 알아야 한다. 설정 안에 묻어 두지 않고 여기 띄운다 */}
        {hub && !hub.personal && hub.conflicts > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              style={{ flex: 1, borderColor: 'var(--warn)', color: 'var(--warn)' }}
              disabled={busy}
              onClick={onSync}
              title="병합할 충돌이 있습니다"
            >
              {syncLabel(hub)}
            </button>
          </div>
        )}
      </div>

      <div style={S.railBody}>
        <InboxSection items={inbox} busy={busy} onIngest={onInbox} />

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
            <ClassBadge value={s.classification} />
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
        <ErrorButton errors={errors} onClick={onDebug} style={{ marginTop: 6, width: '100%' }} />
        {/*
          앱을 벗어나는 세 가지를 한 줄에 모은다. 위쪽은 이 Vault 안에서 하는 일이고
          여기는 Vault 를 바꾸거나 앱을 끝내는 자리다. 섞어 놓으면 실수로 눌린다.
        */}
        <div style={S.exitRow}>
          <button style={S.exitButton} disabled={busy} onClick={onSettings}>
            설정
          </button>
          <button style={S.exitButton} disabled={busy} onClick={onCloseVault} title="Vault 를 닫고 첫 화면으로">
            Vault선택
          </button>
          <button style={S.exitButton} disabled={busy} onClick={onQuit}>
            종료
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * 받은 편지함. `00_INBOX/` 에 놓인 파일을 보여준다.
 * **비어 있으면 아무것도 안 그린다** — 늘 떠 있는 빈 구역은 곧 안 보이게 된다.
 */
function InboxSection({ items, busy, onIngest }: { items: InboxItem[]; busy: boolean; onIngest: () => void }) {
  if (items.length === 0) return null;
  const fresh = items.filter((i) => i.supported && !i.ingested);
  const bad = items.filter((i) => !i.supported);
  return (
    <section style={S.inbox}>
      <div style={S.sectionLabel}>
        받은 편지함 {items.length}건{fresh.length > 0 ? ` · 새 파일 ${fresh.length}건` : ' · 모두 처리됨'}
      </div>
      {items.slice(0, 6).map((i) => (
        <div key={i.filename} style={S.inboxRow} title={i.supported ? '' : '앱이 읽을 수 없는 확장자입니다'}>
          <span style={{ ...S.kindTag, color: i.supported ? 'var(--fg-faint)' : 'var(--warn)' }}>
            {i.ingested ? '처리' : i.supported ? '대기' : '불가'}
          </span>
          <span style={S.sourceName}>{i.filename}</span>
        </div>
      ))}
      {items.length > 6 && <div style={S.inboxMore}>외 {items.length - 6}건</div>}
      {bad.length > 0 && <div style={S.inboxMore}>읽을 수 없는 파일 {bad.length}건은 넘어갑니다</div>}
      <button style={{ width: '100%', marginTop: 6 }} disabled={busy || fresh.length === 0} onClick={onIngest}>
        새 파일 {fresh.length}건 넣기
      </button>
    </section>
  );
}

/** 열람 등급 배지. 사내는 기본값이라 가라앉히고 기밀·제한만 눈에 띄게 한다 */
function ClassBadge({ value }: { value: Classification }) {
  const loud = value === 'confidential' || value === 'restricted';
  return (
    <span
      style={{
        ...S.classBadge,
        color: loud ? 'var(--danger)' : value === 'public' ? 'var(--ok)' : 'var(--fg-faint)',
        borderColor: loud ? 'var(--danger)' : 'var(--border)',
      }}
    >
      {CLASSIFICATION_LABEL[value]}
    </span>
  );
}

/** 레일 버튼 한 줄. 사람이 먼저 알아야 할 것은 충돌이고 그 다음이 보낼 변경이다 */
function syncLabel(hub: HubStatus): string {
  if (!hub.hasToken) return '허브 연결';
  if (hub.conflicts > 0) return `충돌 ${hub.conflicts}건`;
  if (hub.pending > 0) return `동기화 · 보낼 것 ${hub.pending}`;
  return '동기화';
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

      <div style={S.resultBody} className="stagger">
        {len >= 2 && hits.length === 0 && <div style={S.empty}>결과가 없습니다.</div>}
        {len < 2 && !tooShort && (
          <div style={S.empty}>
            원본 {sourceCount}건이 색인돼 있습니다.
            <br />
            <span style={{ color: 'var(--fg-faint)' }}>조사가 붙은 어절도 찾습니다 — “갱신일”로 “갱신일은”이 걸립니다</span>
          </div>
        )}
        {grouped.map(([sourceId, list]) => (
          <section key={sourceId} style={S.hitGroup}>
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
                background: active ? 'var(--info-wash)' : 'var(--bg-raised)',
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
  h1: { fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.02em', margin: '0 0 8px' },
  mark: { display: 'block', marginBottom: 14, borderRadius: 'var(--r-card)' },

  rail: { borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  railHead: { padding: 'var(--s)', borderBottom: '1px solid var(--border)' },
  vaultName: { fontWeight: 600, fontSize: '0.9375rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  lock: {
    display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: '-2px', marginRight: 6,
    fontFamily: 'var(--mono)', fontSize: '0.6875rem', color: 'var(--fg-muted)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '1px 8px 1px 6px',
  },
  railBody: { overflowY: 'auto', flex: 1 },
  sectionLabel: { padding: '10px var(--s) 4px', fontSize: '0.8125rem', color: 'var(--fg-muted)', fontWeight: 500 },
  sourceRow: {
    display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 6, alignItems: 'center',
    width: '100%', textAlign: 'left', border: 'none', borderRadius: 'var(--r-input)',
    padding: '6px var(--s)', background: 'transparent',
  },
  kindTag: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', color: 'var(--fg-faint)', width: 34 },
  sourceName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.875rem' },
  chunkCount: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },
  classField: { display: 'block', marginTop: 10 },
  classLabel: { display: 'block', fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: 4 },
  select: {
    font: 'inherit', fontSize: '0.875rem', width: '100%', padding: '6px 10px',
    borderRadius: 'var(--r-input)', border: '1px solid var(--border)',
    background: 'var(--bg-raised)', color: 'var(--fg)',
  },
  classBadge: {
    fontFamily: 'var(--mono)', fontSize: '0.6875rem', border: '1px solid',
    borderRadius: 'var(--r-pill)', padding: '0 7px', whiteSpace: 'nowrap',
  },
  inbox: { padding: '4px var(--s) var(--s)', borderBottom: '1px solid var(--border)' },
  inboxRow: {
    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 6, alignItems: 'center',
    padding: '3px 0', fontSize: '0.8125rem',
  },
  inboxMore: { fontSize: '0.75rem', color: 'var(--fg-faint)', padding: '2px 0' },
  spendBar: { borderTop: '1px solid var(--border)', padding: '6px var(--s) var(--s)', fontSize: '0.75rem', fontFamily: 'var(--mono)' },
  // 셋을 같은 폭으로 나눠 하나가 눈에 더 띄지 않게 한다. 종료를 붉게 칠하지도 않는다 —
  // 상시 경고색은 곧 무시되고, 여기서 잃는 것은 승인 전 변경안뿐이라 그때만 물어본다.
  exitRow: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 6 },
  exitButton: { fontSize: '0.8125rem', padding: '4px 0', justifyContent: 'center' },

  center: { display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-surface)' },
  searchBar: { padding: 'var(--s)', borderBottom: '1px solid var(--border)' },
  hintWarn: { color: 'var(--warn)', fontSize: '0.8125rem', marginTop: 6 },
  resultBody: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },
  answer: {
    margin: 'var(--s)', padding: 'var(--s)', background: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', boxShadow: 'var(--shadow-card)',
  },
  answerQ: { fontWeight: 600, fontSize: '0.875rem', color: 'var(--fg-muted)' },
  claims: { listStyle: 'none', margin: '10px 0 0', padding: 0, fontSize: '0.875rem' },
  claim: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 },
  chip: {
    fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)',
    border: '1px solid var(--border)', padding: '1px 8px', background: 'var(--bg-raised)', whiteSpace: 'nowrap',
  },
  estimate: {
    display: 'flex', gap: 6, alignItems: 'center', margin: 'var(--s)', padding: 'var(--s)',
    border: '1px solid var(--warn)', borderRadius: 'var(--r-card)', fontSize: '0.8125rem',
  },
  finding: {
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)',
    padding: 'var(--s)', marginBottom: 6, fontSize: '0.875rem', boxShadow: 'var(--shadow-card)',
  },
  findingHead: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--warn)', marginBottom: 4 },
  path: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },
  hitGroup: { marginBottom: 16 },
  hitGroupHead: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-muted)', marginBottom: 4 },
  hitRow: {
    display: 'block', width: '100%', textAlign: 'left', background: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s)',
    marginBottom: 6, boxShadow: 'var(--shadow-card)',
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
    marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-input)',
    border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '0.8125rem',
  },
  chunk: { border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s)', marginBottom: 6, transition: 'background 200ms ease-out' },
  chunkAnchor: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', marginBottom: 4 },

  empty: { padding: 24, color: 'var(--fg-muted)', textAlign: 'center', fontSize: '0.875rem' },
  toast: {
    position: 'fixed', right: 16, bottom: 16, maxWidth: 420,
    background: 'var(--bg-raised)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-card)', padding: 12, boxShadow: 'var(--shadow-pop)',
  },
} satisfies Record<string, React.CSSProperties>;
