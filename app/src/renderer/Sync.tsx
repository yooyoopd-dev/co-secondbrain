// 동기화 화면 — 허브 연결과 3-way 병합. HUB.md §5
//
// **판정은 여기서 하지 않는다.** 병합안은 core/sync/merge.ts 가 만들고, 올릴 수 있는지는
// main 이 다시 본다. 이 파일은 세 판본을 나란히 보여 주고 사람이 고른 결과를 넘길 뿐이다.
//
// 충돌 표시(`<<<<<<<`)가 남은 채로는 저장 버튼을 잠근다. 표시가 그대로 올라간 페이지는
// 다음 사람이 읽을 때 더 큰 비용이 된다.
import { useEffect, useState } from 'react';
import { hasMarkers } from '../core/sync/merge.ts';
import type { SyncConflict, SyncReport } from '../core/sync/index.ts';
import type { HubStatus } from '../main/ipc.ts';

export default function SyncPanel({
  status,
  conflicts,
  report,
  busy,
  note,
  onConnect,
  onDisconnect,
  onSync,
  onResolve,
  onClose,
}: {
  status: HubStatus;
  conflicts: SyncConflict[];
  report: SyncReport | null;
  busy: boolean;
  note: string | null;
  onConnect: (url: string, token: string) => void;
  onDisconnect: () => void;
  onSync: () => void;
  onResolve: (pageId: string, merged: string) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = conflicts.find((c) => c.pageId === picked) ?? conflicts[0] ?? null;

  return (
    <div style={S.scrim} role="dialog" aria-label="동기화">
      <div style={S.panel} className="enter">
        <header style={S.head}>
          <div>
            <div style={S.title}>동기화</div>
            <div style={S.meta}>
              {status.hub ?? '허브 미연결'}
              {status.hasToken && ` · 보낼 변경 ${status.pending}건 · 충돌 ${conflicts.length}건`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s)', alignItems: 'center' }}>
            {note && <span style={S.note}>{note}</span>}
            {status.hasToken && (
              <button disabled={busy} onClick={onDisconnect}>
                연결 끊기
              </button>
            )}
            <button disabled={busy} onClick={onClose}>
              닫기
            </button>
            {status.hasToken && (
              <button className="primary" disabled={busy} onClick={onSync}>
                지금 동기화
              </button>
            )}
          </div>
        </header>

        <div style={S.body}>
          {status.personal && <p style={S.warnBox}>개인 금고는 동기화하지 않습니다. 이 금고의 내용은 이 컴퓨터를 떠나지 않습니다.</p>}

          {!status.personal && !status.hasToken && (
            <Connect status={status} busy={busy} onConnect={onConnect} />
          )}

          {report && <ReportLines report={report} />}

          {current && (
            <Merge
              key={current.pageId}
              conflict={current}
              conflicts={conflicts}
              picked={current.pageId}
              busy={busy}
              onPick={setPicked}
              onResolve={onResolve}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 허브 연결 ---------- */

function Connect({
  status,
  busy,
  onConnect,
}: {
  status: HubStatus;
  busy: boolean;
  onConnect: (url: string, token: string) => void;
}) {
  const [url, setUrl] = useState(status.hub ?? '');
  const [token, setToken] = useState('');
  const ready = /^https?:\/\/\S+$/.test(url.trim()) && token.trim().length > 0;

  return (
    <section style={S.card}>
      <div style={S.cardTitle}>허브 연결</div>
      <p style={S.meta}>
        토큰은 OS 자격 증명 저장소에 암호문으로 들어갑니다. 금고 폴더에는 쓰지 않습니다.
      </p>
      {!status.canStoreToken && (
        <p style={S.warnBox}>
          이 시스템에서는 토큰을 안전하게 보관할 수 없습니다. 관리자에게 문의하십시오.
        </p>
      )}
      <label style={S.field}>
        <span style={S.fieldLabel}>허브 주소</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://co-hub:8080"
          spellCheck={false}
          disabled={busy || !status.canStoreToken}
        />
      </label>
      <label style={S.field}>
        <span style={S.fieldLabel}>토큰</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
          disabled={busy || !status.canStoreToken}
        />
      </label>
      <button
        className="primary"
        style={{ marginTop: 'var(--s)' }}
        disabled={busy || !ready || !status.canStoreToken}
        onClick={() => onConnect(url.trim(), token.trim())}
      >
        연결
      </button>
    </section>
  );
}

/* ---------- 동기화 결과 ---------- */

function ReportLines({ report }: { report: SyncReport }) {
  return (
    <section style={S.card}>
      <div style={S.cardTitle}>
        받기 {report.pulled.length}건 · 보내기 {report.pushed.length}건 · 충돌 {report.conflicts.length}건
      </div>
      {report.offline && <p style={S.warnBox}>허브에 닿지 못했습니다. 변경은 그대로 남아 다음에 올라갑니다.</p>}
      {report.skipped.length > 0 && (
        <ul style={S.skipped}>
          {report.skipped.map((s, i) => (
            <li key={i}>
              <span style={S.path}>{s.path}</span> — {s.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- 3-way 병합 ---------- */

function Merge({
  conflict,
  conflicts,
  picked,
  busy,
  onPick,
  onResolve,
}: {
  conflict: SyncConflict;
  conflicts: SyncConflict[];
  picked: string;
  busy: boolean;
  onPick: (pageId: string) => void;
  onResolve: (pageId: string, merged: string) => void;
}) {
  const [text, setText] = useState(conflict.merged.text);
  // 허브가 또 바뀌면 같은 페이지에 새 재료가 온다. 그때는 편집 내용을 버린다
  useEffect(() => setText(conflict.merged.text), [conflict.merged.text]);

  const marked = hasMarkers(text);

  return (
    <section style={S.card}>
      {conflicts.length > 1 && (
        <div style={S.tabs}>
          {conflicts.map((c) => (
            <button key={c.pageId} style={c.pageId === picked ? S.tabOn : S.tab} onClick={() => onPick(c.pageId)}>
              {c.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      <div style={S.cardHead}>
        <span style={S.cardTitle}>{conflict.path}</span>
        <span style={S.path}>서버 판본 v{conflict.serverVersion}</span>
        <span style={conflict.merged.clean ? S.okTag : S.warnTag}>
          {conflict.merged.clean ? '자동 병합됨' : `같은 줄 충돌 ${conflict.merged.conflicts}곳`}
        </span>
      </div>

      <div style={S.panes}>
        <Pane label="기준" text={conflict.base} />
        <Pane label="내 것" text={conflict.mine} />
        <Pane label="서버" text={conflict.theirs} />
      </div>

      <div style={S.cardFoot}>
        <span style={S.meta}>병합 결과</span>
        <button disabled={busy} onClick={() => setText(conflict.mine)}>
          내 것으로
        </button>
        <button disabled={busy} onClick={() => setText(conflict.theirs)}>
          서버 것으로
        </button>
        <button disabled={busy} onClick={() => setText(conflict.merged.text)}>
          병합안으로
        </button>
      </div>

      <textarea style={S.editor} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />

      <div style={S.cardFoot}>
        {marked && <span style={S.warnTag}>충돌 표시를 지워야 올릴 수 있습니다</span>}
        <button
          className="primary"
          style={{ marginLeft: 'auto' }}
          disabled={busy || marked}
          onClick={() => onResolve(conflict.pageId, text)}
        >
          이 내용으로 올리기
        </button>
      </div>
    </section>
  );
}

function Pane({ label, text }: { label: string; text: string }) {
  return (
    <div style={S.pane}>
      <div style={S.paneHead}>{label}</div>
      <pre style={S.paneBody}>{text || '(없음)'}</pre>
    </div>
  );
}

const S = {
  scrim: {
    position: 'fixed', inset: 0, background: 'rgba(28,28,28,0.28)',
    display: 'grid', placeItems: 'center', padding: 24, zIndex: 10,
  },
  panel: {
    display: 'flex', flexDirection: 'column', width: 'min(1100px, 100%)', height: '100%',
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-modal)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s)',
    padding: 'var(--s)', borderBottom: '1px solid var(--border)',
  },
  title: { fontWeight: 600 },
  meta: { fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  note: { fontSize: '0.8125rem', color: 'var(--fg-muted)', maxWidth: 320, textAlign: 'right' },
  body: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },

  card: {
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)',
    padding: 'var(--s)', marginBottom: 'var(--s)', boxShadow: 'var(--shadow-card)',
  },
  cardHead: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 'var(--s)', alignItems: 'baseline' },
  cardTitle: { fontWeight: 600 },
  cardFoot: { marginTop: 10, display: 'flex', gap: 6, alignItems: 'center' },
  path: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)' },

  field: { display: 'block', marginTop: 'var(--s)' },
  fieldLabel: { display: 'block', fontSize: '0.8125rem', color: 'var(--fg-muted)', marginBottom: 4 },

  warnBox: {
    marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-input)',
    border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '0.8125rem',
  },
  warnTag: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--warn)' },
  okTag: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--ok)' },
  skipped: { margin: '6px 0 0', paddingLeft: 18, fontSize: '0.8125rem', color: 'var(--fg-muted)' },

  tabs: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 'var(--s)' },
  tab: { fontFamily: 'var(--mono)', fontSize: '0.75rem', padding: '2px 8px' },
  tabOn: { fontFamily: 'var(--mono)', fontSize: '0.75rem', padding: '2px 8px', borderColor: 'var(--info)', color: 'var(--info)', background: 'var(--info-wash)' },

  panes: {
    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, marginTop: 10,
    background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 'var(--r-input)', overflow: 'hidden',
  },
  pane: { background: 'var(--bg-raised)', display: 'flex', flexDirection: 'column', minWidth: 0 },
  paneHead: { background: 'var(--bg-canvas)', color: 'var(--fg-muted)', fontSize: '0.75rem', padding: '3px 8px' },
  paneBody: {
    margin: 0, padding: '4px 8px', maxHeight: 220, overflow: 'auto',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
  editor: {
    width: '100%', minHeight: 240, marginTop: 6, padding: 'var(--s)', resize: 'vertical',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5,
    background: 'var(--bg-raised)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-input)',
  },
} satisfies Record<string, React.CSSProperties>;
