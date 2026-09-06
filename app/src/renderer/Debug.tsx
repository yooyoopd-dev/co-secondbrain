// 오류 기록 화면. 무엇이 실패했는지 통째로 복사해 넘길 수 있어야 한다.
//
// **판정도 가공도 여기서 하지 않는다.** 파일명과 토큰은 main 이 적재할 때 이미 지웠고
// (core/log.ts) 이 파일은 받은 것을 그리고 [복사]를 main 으로 넘길 뿐이다.
import { useEffect, useState } from 'react';
import type { LogEntry, LogLevel } from '../core/log.ts';
import { Icon } from './icons.tsx';

const LEVEL_LABEL: Record<LogLevel, string> = { error: '오류', warn: '경고', info: '정보' };
const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'var(--danger)',
  warn: 'var(--warn)',
  info: 'var(--fg-faint)',
};

export default function DebugPanel({
  entries,
  busy,
  onCopy,
  onSave,
  onClear,
  onClose,
}: {
  entries: LogEntry[];
  busy: boolean;
  onCopy: () => void;
  onSave: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [errorsOnly, setErrorsOnly] = useState(true);
  const shown = errorsOnly ? entries.filter((e) => e.level === 'error') : entries;

  // 기록은 시간순으로 쌓이지만 사람이 먼저 볼 것은 방금 난 것이다
  const rows = [...shown].reverse();

  return (
    <div style={S.scrim} role="dialog" aria-label="오류 기록">
      <div style={S.panel} className="enter">
        <header style={S.head}>
          <div>
            <div style={S.title}>오류 기록</div>
            <div style={S.meta}>
              전체 {entries.length}건 · 오류 {entries.filter((e) => e.level === 'error').length}건
            </div>
          </div>
          <div style={S.actions}>
            <label style={S.check}>
              <input type="checkbox" checked={errorsOnly} onChange={() => setErrorsOnly((v) => !v)} />
              오류만
            </label>
            <button disabled={busy || entries.length === 0} onClick={onClear}>
              <Icon name="trash" /> 비우기
            </button>
            <button disabled={busy || entries.length === 0} onClick={onSave}>
              <Icon name="save" /> 파일로
            </button>
            <button className="primary" disabled={busy} onClick={onCopy}>
              <Icon name="copy" /> 복사
            </button>
            <button aria-label="닫기" disabled={busy} onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div style={S.body}>
          <p style={S.notice}>
            파일 이름과 토큰은 지우고 적습니다. 확장자와 글자 수만 남으므로 이대로 붙여
            넣어도 문서 이름이 나가지 않습니다.
          </p>

          {rows.length === 0 && (
            <div style={S.empty}>
              <Icon name="alert" size={22} />
              <div style={{ marginTop: 6 }}>{errorsOnly ? '오류가 없습니다.' : '기록이 없습니다.'}</div>
            </div>
          )}

          <div className="stagger">
            {rows.map((e, i) => (
              <article key={`${e.at}-${i}`} style={S.row}>
                <div style={S.rowHead}>
                  <span style={{ ...S.level, color: LEVEL_COLOR[e.level], borderColor: LEVEL_COLOR[e.level] }}>
                    {LEVEL_LABEL[e.level]}
                  </span>
                  <span style={S.scope}>{e.scope}</span>
                  <span style={S.at}>{e.at.replace('T', ' ').replace('Z', '')}</span>
                </div>
                <div style={S.message}>{e.message}</div>
                {e.detail && <pre style={S.detail}>{e.detail}</pre>}
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  scrim: {
    position: 'fixed', inset: 0, background: 'rgba(28,28,28,0.28)',
    display: 'grid', placeItems: 'center', padding: 24, zIndex: 10,
  },
  panel: {
    display: 'flex', flexDirection: 'column', width: 'min(900px, 100%)', height: '100%',
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-modal)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s)',
    padding: 'var(--s)', borderBottom: '1px solid var(--border)',
  },
  actions: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
  title: { fontWeight: 600 },
  meta: { fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  check: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.8125rem', cursor: 'pointer', marginRight: 4 },
  body: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },
  notice: {
    margin: '0 0 var(--s)', padding: 'var(--s)', borderRadius: 'var(--r-card)',
    background: 'var(--tint)', color: 'var(--fg-muted)', fontSize: '0.8125rem',
  },

  row: {
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)',
    padding: 'var(--s)', marginBottom: 6, boxShadow: 'var(--shadow-card)',
  },
  rowHead: { display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: 'var(--s)', alignItems: 'baseline' },
  level: {
    fontFamily: 'var(--mono)', fontSize: '0.6875rem', border: '1px solid',
    borderRadius: 'var(--r-pill)', padding: '0 7px', whiteSpace: 'nowrap',
  },
  scope: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-muted)' },
  at: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', textAlign: 'right' },
  message: { marginTop: 4, fontSize: '0.875rem', wordBreak: 'break-word' },
  detail: {
    margin: '6px 0 0', padding: 'var(--s)', maxHeight: 200, overflow: 'auto',
    background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 'var(--r-input)',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
  empty: { padding: 32, color: 'var(--fg-muted)', textAlign: 'center', fontSize: '0.875rem' },
} satisfies Record<string, React.CSSProperties>;
