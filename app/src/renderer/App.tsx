// 3-pane 셸. DESIGN-SYSTEM.md 의 토큰만 쓴다.
// 좌: 원본 목록 / 중: 검색 결과 / 우: 원문 뷰어 (앵커로 점프)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Extraction, SearchHit } from '../core/types.ts';
import type {
  SbApi, AnswerWith, AppSettings, HeldReviewInfo, HubStatus, InboxItem, IngestResult, LocalInfo, ProviderPick, SourceSummary, TaskProviders,
} from '../main/ipc.ts';
import type { LocalConfig } from '../core/local/ollama.ts';
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
import { DedupButton, DedupPanel } from './Dedup.tsx';
import type { Finding } from '../core/lint/index.ts';
import type { RejectedPair } from '../core/lint/rejected.ts';
import { Icon } from './icons.tsx';
import { Markdown, MarkdownSnippet, MdToggle, type MdView } from './Markdown.tsx';

/** CLI 출력은 끝없이 쌓인다. 화면에 남기는 줄 수만 붙든다 */
const RUN_LINES = 40;

/** 화면에 적는 공급자 이름. 라우팅이 거절했으면 사유를 그대로 보여준다 */
function providerLabel(p: ProviderPick | undefined): string {
  if (!p) return '확인 중';
  return p.ok ? p.provider : '쓸 수 없음';
}

/** 질의를 누가 맡나. 로컬은 라우터 밖의 축이라 `query` 를 안 본다 */
function askLabel(t: TaskProviders | null): string {
  if (!t) return '확인 중';
  return t.answerWith === 'local' ? '로컬' : providerLabel(t.query);
}

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
  // 중복 후보. 열 때 계산 검사 #9 를 다시 돌린다 — 돈이 안 들어 캐시할 이유가 없다.
  const [dedup, setDedup] = useState<{ candidates: Finding[]; rejected: RejectedPair[] } | null>(null);
  // 설정과 내 맥락. 정본은 main(과 Vault 의 파일)이고 화면은 사본을 그린다
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // 렌더링·원본 토글. 검색 결과와 원문 뷰어가 같은 값을 쓴다 — 따로 두면 헷갈린다
  const [mdView, setMdView] = useState<MdView>('render');
  // 어느 CLI 가 무엇을 맡는지. 누르기 전에 화면에 적어 둔다
  const [providers, setProviders] = useState<TaskProviders | null>(null);
  // 위키가 실제로 인용하고 있는 원본. 목록에 반영 표시를 그린다
  const [cited, setCited] = useState<ReadonlySet<string>>(new Set());
  // 전체 보류해 둔 변경안. `.sb/` 에 있고 다시 열어야 관문을 거친다
  const [held, setHeld] = useState<HeldReviewInfo | null>(null);
  const [heldApproved, setHeldApproved] = useState<readonly string[] | undefined>(undefined);
  // CLI 가 도는 동안만 산다. 취소 버튼과 진행 표시가 여기를 본다
  const [run, setRun] = useState<{ label: string; provider: string; lines: string[] } | null>(null);
  // 로컬 모델 상태. 설정을 열 때만 물어본다 — Ollama 에 붙는 데 시간이 든다
  const [localInfo, setLocalInfo] = useState<LocalInfo | null>(null);
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
    setHeld(await window.sb.heldReview());
    setProviders(await window.sb.taskProviders());
    setCited(new Set(await window.sb.citedSources()));
    await pullLogs();
  }, [pullLogs]);

  // CLI 가 뱉는 것을 받는다. 표면에서 유일하게 main 이 밀어 주는 채널이다.
  useEffect(
    () =>
      window.sb.agentOutput((chunk) => {
        const lines = chunk.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (lines.length === 0) return;
        setRun((r) => (r ? { ...r, lines: [...r.lines, ...lines].slice(-RUN_LINES) } : r));
      }),
    [],
  );

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
    setHeldApproved(undefined);
    setRun({ label: '위키 갱신', provider: providerLabel(providers?.ingest), lines: [] });
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
      setRun(null);
      setBusy(false);
    }
  };

  /** 도는 CLI 를 끊는다. 죽인 뒤의 뒤처리는 propose·ask 의 finally 가 한다 */
  const cancelRun = async () => {
    await window.sb.cancelAgent();
  };

  /** 보류해 둔 것을 다시 연다. 관문은 여기서 처음부터 다시 돈다 */
  const resumeHeld = async () => {
    setBusy(true);
    try {
      const r = await window.sb.resumeReview();
      if (!r) {
        setHeld(null);
        return;
      }
      setHeldApproved(r.approved);
      setReview(r.review);
    } finally {
      setBusy(false);
    }
  };

  const holdReview = async (approved: string[]) => {
    setBusy(true);
    try {
      await window.sb.holdReview(approved);
      setReview(null);
      setHeldApproved(undefined);
      setReviewNote('검토를 보류했습니다. 왼쪽 [검토 대기] 에서 다시 엽니다');
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

  /** 없는 앵커 인용을 앱이 지운다. 사람이 본문에서 하나씩 찾아 지우던 일이다 */
  const repairAnchors = async () => {
    setBusy(true);
    try {
      const r = await window.sb.repairAnchors();
      setReview(r.review);
      setReviewNote(`없는 앵커 ${r.removed}건을 지웠습니다. 관문을 다시 돌린 결과입니다`);
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
    setHeldApproved(undefined);
    setReviewNote(null);
    await refresh();
  };

  const ask = async (question: string) => {
    setBusy(true);
    setReviewNote(null);
    setAnswer(null);
    setRun({ label: '위키에 묻기', provider: askLabel(providers), lines: [] });
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
      setRun(null);
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

  /**
   * 새로 고침은 다시 읽기만 하는 것이 아니다. `01_SOURCES/` 에서 사라진 원본을 같이 정리한다 —
   * 사람이 탐색기에서 지운 파일이 목록에 남아 있으면 목록을 못 믿게 된다.
   * 위키가 인용 중인 것은 안 지우고 남겨 둔 사유를 적어 준다 (store.sweepSources).
   */
  const sweepAndRefresh = async () => {
    setBusy(true);
    try {
      const r = await window.sb.sweepSources();
      await refresh();
      if (r.removed.length || r.kept.length) {
        const parts: string[] = [];
        if (r.removed.length) parts.push(`사라진 원본 ${r.removed.length}건을 목록에서 뺐습니다`);
        if (r.kept.length) parts.push(`${r.kept.length}건은 위키가 인용 중이라 남겼습니다`);
        setReviewNote(parts.join('. '));
      }
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    setSettings(await window.sb.settings());
    // 화면을 붙들지 않는다. Ollama 가 꺼져 있으면 응답까지 몇 초가 걸린다
    setLocalInfo(null);
    void window.sb.localInfo().then(setLocalInfo);
  };

  const pickAnswerWith = async (mode: AnswerWith) => {
    await window.sb.setAnswerWith(mode);
    setSettings(await window.sb.settings());
    // 버튼 라벨이 이 값을 본다. 무언가 실행한 뒤에 바뀌면 안 된다
    setProviders(await window.sb.taskProviders());
    if (mode === 'local') void window.sb.localInfo().then(setLocalInfo);
  };

  const saveLocalConfig = async (cfg: LocalConfig) => {
    await window.sb.setLocalConfig(cfg);
    setSettings(await window.sb.settings());
    setLocalInfo(null);
    void window.sb.localInfo().then(setLocalInfo);
  };

  /** 오래 돈다. 진행 줄은 CLI 와 같은 자리에 뜨고 취소 버튼도 그대로 듣는다 */
  const buildVectors = async () => {
    setBusy(true);
    setRun({ label: '위키 임베딩 만들기', provider: '로컬', lines: [] });
    try {
      const r = await window.sb.buildVectors();
      setReviewNote(r.ok ? `임베딩 ${r.made}개를 새로 만들었습니다 (모두 ${r.total}개)` : r.error);
      setLocalInfo(await window.sb.localInfo());
    } finally {
      setRun(null);
      setBusy(false);
    }
  };

  /**
   * 쓸 CLI 를 바꾼다. **버튼에 적힌 이름도 여기서 같이 갱신한다** — 전에는 다음
   * `refresh()` 까지 옛 이름이 남아서, 무언가 한 번 실행해야 바뀌는 것처럼 보였다.
   */
  const pickProvider = async (id: ProviderId | null) => {
    await window.sb.setProvider(id);
    setSettings(await window.sb.settings());
    setProviders(await window.sb.taskProviders());
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

  /* 중복 후보 — 계산 검사 #9. LLM 을 안 부르므로 열 때마다 다시 돌린다 */

  const loadDedup = async () => ({
    candidates: (await window.sb.lintComputed()).findings.filter((f) => f.check === 9),
    rejected: await window.sb.rejectedDuplicates(),
  });

  const openDedup = async () => {
    setBusy(true);
    try {
      setDedup(await loadDedup());
    } finally {
      setBusy(false);
    }
  };

  /** 거부하면 그 쌍이 후보에서 빠진다. 목록을 다시 읽어 바로 보인다 */
  const rejectDup = async (a: string, b: string) => {
    setBusy(true);
    try {
      await window.sb.rejectDuplicate(a, b);
      setDedup(await loadDedup());
    } finally {
      setBusy(false);
    }
  };

  const unrejectDup = async (a: string, b: string) => {
    setBusy(true);
    try {
      await window.sb.unrejectDuplicate(a, b);
      setDedup(await loadDedup());
    } finally {
      setBusy(false);
    }
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
        cited={cited}
        onRefresh={() => void sweepAndRefresh()}
        spend={spend}
        pending={pending}
        onLint={async () => setEstimate(await window.sb.estimateJudgment())}
        onDedup={() => void openDedup()}
        onExport={exportDeck}
        hub={hub}
        onSync={openSync}
        errors={errors}
        onDebug={() => void debug.open()}
        held={held}
        onResume={() => void resumeHeld()}
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
        mdView={mdView}
        onMdView={setMdView}
        queryProvider={providers?.query}
        local={providers?.answerWith === 'local'}
      />
      <Viewer
        viewer={viewer}
        busy={busy}
        note={reviewNote}
        onPropose={propose}
        mdView={mdView}
        onMdView={setMdView}
        ingestProvider={providers?.ingest}
      />
      {/*
        둘 다 화면 아래에 뜬다. 전에는 진행 막대가 가운데, 인제스트 결과가 오른쪽이라
        창이 좁으면 겹쳤다. 한 칸에 세로로 쌓으면 어느 폭에서도 안 겹친다.
      */}
      {(run || report) && (
        <div style={S.bottomStack}>
          {report && <ReportToast report={report} onClose={() => setReport(null)} />}
          {run && <RunBar run={run} onCancel={() => void cancelRun()} />}
        </div>
      )}
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
          {...(heldApproved ? { initialApproved: heldApproved } : null)}
          onApply={applyReview}
          onHold={(approved) => void holdReview(approved)}
          onCancel={discardReview}
          onJump={(sourceId, locator) => void jump(sourceId, locator)}
          onEdit={(path, content) => void editOp(path, content)}
          onRepair={() => void repairAnchors()}
        />
      )}
      {settings && (
        <SettingsPanel
          settings={settings}
          hub={hub}
          local={localInfo}
          busy={busy}
          onProvider={(id) => void pickProvider(id)}
          onAnswerWith={(mode) => void pickAnswerWith(mode)}
          onLocalConfig={(cfg) => void saveLocalConfig(cfg)}
          onBuildVectors={() => void buildVectors()}
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
      {dedup && (
        <DedupPanel
          candidates={dedup.candidates}
          rejected={dedup.rejected}
          busy={busy}
          onReject={(a, b) => void rejectDup(a, b)}
          onUnreject={(a, b) => void unrejectDup(a, b)}
          onClose={() => setDedup(null)}
        />
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
  cited,
  onRefresh,
  spend,
  pending,
  onLint,
  onDedup,
  onExport,
  hub,
  onSync,
  errors,
  onDebug,
  held,
  onResume,
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
  /** 위키가 인용하고 있는 원본 id. 여기 있으면 반영된 것이다 */
  cited: ReadonlySet<string>;
  onRefresh: () => void;
  spend: Status[];
  pending: number | null;
  onLint: () => void;
  onDedup: () => void;
  onExport: () => void;
  hub: HubStatus | null;
  onSync: () => void;
  /** 전체 보류해 둔 변경안. 없으면 줄을 안 그린다 */
  held: HeldReviewInfo | null;
  onResume: () => void;
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
        {/*
          셋을 한 줄에 같은 폭으로 둔다. 아래 [설정] 줄과 같은 글자 크기라 레일에서
          두 줄이 같은 무게로 읽힌다 — 여기는 전부 이 Vault 안에서 하는 일이다.
        */}
        <div style={S.railActions}>
          <button style={S.railAction} disabled={busy} onClick={onLint} title="LLM 판단 검사 4종">
            판단 검사
          </button>
          <button style={S.railAction} disabled={busy} onClick={onExport} title="Marp 슬라이드로 내보내기">
            내보내기
          </button>
          <DedupButton count={null} busy={busy} onClick={onDedup} style={S.railAction} />
        </div>
        {/*
          보류해 둔 변경안. 돈을 이미 쓴 결과라 눈에 띄어야 한다 — 설정 안에 묻으면
          다음에 또 CLI 를 부른다.
        */}
        {held && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              style={{ flex: 1, borderColor: 'var(--info)', color: 'var(--info)' }}
              disabled={busy}
              onClick={onResume}
              title={held.summary}
            >
              검토 대기 {held.ops}건
            </button>
          </div>
        )}
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

        {/* 폴더를 앱 밖에서 고쳤을 때 다시 읽는 자리. 창을 껐다 켜지 않아도 된다 */}
        <div style={S.sourcesHead}>
          <span style={S.sectionLabel}>
            원본 {sources.length}건{pending !== null && pending > 0 ? ` · 제안 대기 ${pending}건` : ''}
          </span>
          <button style={S.refresh} disabled={busy} onClick={onRefresh} title="원본과 받은 편지함을 다시 읽습니다">
            <Icon name="refresh" size={13} />
            새로 고침
          </button>
        </div>
        {busy && sources.length === 0 && (
          <div style={{ padding: 'var(--s)' }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 32, marginBottom: 6 }} />
            ))}
          </div>
        )}
        {sources.map((s) => (
          <button
            key={s.sourceId}
            style={S.sourceRow}
            onClick={() => onSelect(s.sourceId)}
            title={s.missing ? '원본 파일이 01_SOURCES 에 없습니다. 추출해 둔 내용만 남아 있습니다' : s.filename}
          >
            <span style={S.kindTag}>{s.kind}</span>
            {/* 파일이 없어진 것은 취소선으로 표시한다. 글머리 기호를 붙이면 목록이 들쭉날쭉해진다 */}
            <span
              style={{
                ...S.sourceName,
                ...(s.missing ? { color: 'var(--fg-faint)', textDecoration: 'line-through' } : {}),
              }}
            >
              {s.filename}
            </span>
            <WikiMark cited={cited.has(s.sourceId)} />
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

      {/*
        이번 달 쓴 돈만 적는다. "남은 문서 약 N건" 은 뺐다 — 문서당 단가가 표본
        몇 건에서 나온 값이라 건수로 바꾸면 실제보다 정확해 보인다 (M2-PLAN.md §3.4
        의 판단을 사용자 요청으로 되돌린 것이다). 상한 대비 비율은 색으로 남는다.
      */}
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

/**
 * 이 원본이 위키에 들어갔는가.
 *
 * **"변경안을 만들었다" 가 아니라 "위키가 인용하고 있다" 를 본다** (store.citedSources).
 * 제안만 하고 승인을 안 한 원본을 반영됨으로 그리면 표시가 거짓말이 된다.
 * 아직 안 들어간 것은 흐린 점으로 둔다 — 안 그리면 목록이 들쭉날쭉해 보인다.
 */
function WikiMark({ cited }: { cited: boolean }) {
  return cited ? (
    <span style={{ ...S.wikiMark, color: 'var(--ok)' }} title="위키가 이 원본을 인용하고 있습니다">
      <Icon name="check" size={13} />
    </span>
  ) : (
    <span style={{ ...S.wikiMark, color: 'var(--fg-faint)' }} title="아직 위키에 안 들어갔습니다">
      ·
    </span>
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
  mdView,
  onMdView,
  queryProvider,
  local,
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
  mdView: MdView;
  onMdView: (v: MdView) => void;
  /** [위키에 묻기] 를 실제로 맡을 공급자. 라우팅이 거절하면 사유가 온다 */
  queryProvider: ProviderPick | undefined;
  /** 로컬 모델로 답하는 설정인가. 그러면 공급자 라우팅을 안 본다 */
  local: boolean;
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
        {/*
          검색과 질의는 보는 대상도 비용도 다르다. 버튼에 어느 CLI 가 도는지 적어
          **누르기 전에** 알 수 있게 한다 — 눌러 본 뒤에 거절 사유를 보는 것은 늦다.
        */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <button
            disabled={busy || len < 2 || (!local && queryProvider?.ok === false)}
            onClick={() => onAsk(query.trim())}
            title={
              local
                ? '이 컴퓨터의 Ollama 로 답합니다. 내용이 밖으로 안 나갑니다'
                : queryProvider?.ok === false
                  ? queryProvider.reason
                  : '검색은 원본을, 질의는 위키를 봅니다'
            }
          >
            위키에 묻기{local ? ' (로컬)' : queryProvider?.ok ? ` (${queryProvider.provider})` : ''}
          </button>
          {!local && queryProvider?.ok === false ? (
            <span style={{ fontSize: '0.75rem', color: 'var(--warn)' }}>{queryProvider.reason}</span>
          ) : (
            <span style={{ fontSize: '0.75rem', color: 'var(--fg-faint)' }}>
              검색은 원본을 그대로, 질의는 위키를 LLM 이 읽고 답합니다
            </span>
          )}
        </div>
      </div>

      {answer && <AnswerCard entry={answer} busy={busy} onJump={onJump} onArchive={onArchive} />}
      {estimate && <EstimateBar estimate={estimate} busy={busy} onRun={onRunLint} onCancel={onCancelLint} />}
      {judgment && <JudgmentList result={judgment} />}

      {/* 이 목록이 무엇인지 먼저 적는다. 위의 답변 카드와 섞여 보였다 */}
      {len >= 2 && (
        <div style={S.resultHead}>
          <span style={S.resultTitle}>원본 검색 결과 {hits.length}건</span>
          <span style={{ flex: 1 }} />
          <MdToggle view={mdView} onChange={onMdView} />
        </div>
      )}

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
                <span style={S.snippet}>
                  <MarkdownSnippet text={h.snippet} view={mdView} />
                </span>
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
  mdView,
  onMdView,
  ingestProvider,
}: {
  viewer: { ext: Extraction; locator: string | null } | null;
  busy: boolean;
  note: string | null;
  onPropose: (sourceId: string) => void;
  mdView: MdView;
  onMdView: (v: MdView) => void;
  /** [이 원본으로 위키 갱신] 을 맡을 공급자 */
  ingestProvider: ProviderPick | undefined;
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
          {/* 옆의 [렌더링] 토글과 같은 글자 크기다. 머리글 줄에서 하나만 커 보이면 안 된다 */}
          <button
            style={S.viewerAction}
            disabled={busy || ingestProvider?.ok === false}
            onClick={() => onPropose(ext.sourceId)}
            title={ingestProvider?.ok === false ? ingestProvider.reason : ingestProvider?.why}
          >
            위키 갱신{ingestProvider?.ok ? ` (${ingestProvider.provider})` : ''}
          </button>
          <span style={{ flex: 1 }} />
          <MdToggle view={mdView} onChange={onMdView} />
        </div>
        {ingestProvider?.ok === false && <div style={S.warnBox}>{ingestProvider.reason}</div>}
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
              <Markdown text={c.text} view={mdView} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ---------- CLI 진행 ---------- */

/**
 * CLI 가 도는 동안만 뜬다. **취소가 여기 있어야 한다** — 5분 시간 제한까지 기다리는 것과
 * 끊는 것을 사람이 고를 수 있어야 한다.
 *
 * 흐르는 글은 CLI 가 주는 대로다. `--output-format json` 은 끝에 한 덩어리로 주므로
 * 도는 동안 보이는 것은 주로 stderr 이고, 비어 있어도 안 도는 것이 아니다. 그래서
 * 경과 시간을 같이 센다.
 */
function RunBar({ run, onCancel }: { run: { label: string; provider: string; lines: string[] }; onCancel: () => void }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={S.run} className="enter" role="status">
      <div style={S.runHead}>
        <span className="skeleton" style={{ width: 14, height: 14, borderRadius: 7 }} />
        <span style={{ fontWeight: 600 }}>{run.label}</span>
        <span style={S.runProvider}>{run.provider}</span>
        <span style={S.runTime}>{sec}초</span>
        <span style={{ flex: 1 }} />
        <button onClick={onCancel}>취소</button>
      </div>
      <pre style={S.runLog}>
        {run.lines.length > 0 ? run.lines.join('\n') : 'CLI 를 띄웠습니다. 아직 내보낸 것이 없습니다.'}
      </pre>
    </div>
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
  sourcesHead: { display: 'flex', alignItems: 'center', paddingRight: 'var(--s)' },
  refresh: {
    marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: '0.75rem', padding: '2px 8px', color: 'var(--fg-muted)', borderColor: 'var(--border)',
  },
  wikiMark: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, fontFamily: 'var(--mono)' },
  // 판단 검사 · 내보내기 · 중복 후보. 아래 [설정] 줄과 같은 크기다
  railActions: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 6 },
  railAction: { fontSize: '0.8125rem', padding: '4px 0', justifyContent: 'center', width: '100%' },
  sourceRow: {
    display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 6, alignItems: 'center',
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
  resultHead: {
    display: 'flex', alignItems: 'center', gap: 'var(--s)',
    padding: '6px var(--s)', borderBottom: '1px solid var(--border)',
  },
  resultTitle: { fontSize: '0.8125rem', color: 'var(--fg-muted)' },

  // 화면 아래 가운데 한 칸. 진행 막대와 인제스트 결과가 여기 세로로 쌓인다.
  bottomStack: {
    position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 9,
    width: 'min(620px, calc(100vw - 48px))',
    display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch',
  },
  run: {
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-card)', boxShadow: 'var(--shadow-pop)', padding: 'var(--s)',
  },
  runHead: { display: 'flex', gap: 'var(--s)', alignItems: 'center' },
  runProvider: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)' },
  runTime: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },
  runLog: {
    margin: '8px 0 0', maxHeight: 140, overflowY: 'auto', padding: '6px 8px',
    background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 'var(--r-input)',
    fontFamily: 'var(--mono)', fontSize: '0.6875rem', lineHeight: 1.5,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--fg-muted)',
  },
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
  // Markdown.tsx 의 [렌더링]·[원본] 토글과 같은 크기
  viewerAction: { fontSize: '0.75rem', padding: '2px 10px' },
  viewerNote: { marginTop: 8, fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  warnBox: {
    marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-input)',
    border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '0.8125rem',
  },
  chunk: { border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 'var(--s)', marginBottom: 6, transition: 'background 200ms ease-out' },
  chunkAnchor: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', marginBottom: 4 },

  empty: { padding: 24, color: 'var(--fg-muted)', textAlign: 'center', fontSize: '0.875rem' },
  toast: {
    background: 'var(--bg-raised)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-card)', padding: 12, boxShadow: 'var(--shadow-pop)',
  },
} satisfies Record<string, React.CSSProperties>;
