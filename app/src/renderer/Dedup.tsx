// 중복 후보 화면. ROADMAP.md §14, 계산 검사 #9
//
// **자동 병합은 없다.** 후보만 보여주고 사람이 정한다. 위키에서 오병합은 복구가 어렵다.
//
// 사람이 [다른 대상이다] 를 누르면 그 판단이 Vault 에 남고 다음부터 안 뜬다. 한 번 판정한
// 것을 매번 다시 물으면 사람이 Lint 를 통째로 무시하게 된다. 그리고 **거부 하나가 곧
// 오병합 표본 하나라** 쓰다 보면 임계를 다시 잴 근거가 저절로 쌓인다.
import type { Finding } from '../core/lint/index.ts';
import type { RejectedPair } from '../core/lint/rejected.ts';
import { Shell } from './Settings.tsx';

export function DedupPanel({
  candidates,
  rejected,
  busy,
  onReject,
  onUnreject,
  onClose,
}: {
  /** 계산 검사 #9 의 지적. `labels` 가 붙어 있어 id 를 되짚지 않는다 */
  candidates: readonly Finding[];
  rejected: readonly RejectedPair[];
  busy: boolean;
  onReject: (a: string, b: string) => void;
  onUnreject: (a: string, b: string) => void;
  onClose: () => void;
}) {
  return (
    <Shell title="중복 후보" busy={busy} onClose={onClose}>
      <p style={S.note}>
        이름이 비슷한 페이지 쌍입니다. <b>자동으로 합치지 않습니다</b> — 한쪽을 지우고
        aliases 에 넣을지 사람이 정합니다. 다른 대상이면 눌러 두십시오. 다음부터 안 뜹니다.
      </p>

      {candidates.length === 0 ? (
        <div style={S.dim}>지금은 후보가 없습니다.</div>
      ) : (
        candidates.map((f) => {
          const [a, b] = f.labels ?? [f.page, f.related ?? ''];
          return (
            <div key={`${f.page} ${f.related}`} style={S.row}>
              <div style={S.pair}>
                <span style={S.name}>{a}</span>
                <span style={S.arrow}>↔</span>
                <span style={S.name}>{b}</span>
              </div>
              <div style={S.why}>{f.message}</div>
              <div style={S.buttons}>
                <button disabled={busy} onClick={() => onReject(a, b)}>
                  다른 대상이다
                </button>
              </div>
            </div>
          );
        })
      )}

      {rejected.length > 0 && (
        <section style={S.block}>
          {/* 누적 개수가 곧 오병합 건수다. 사내에서 따로 세던 그 숫자다 (ROADMAP §14.2) */}
          <div style={S.blockHead}>다른 대상이라고 한 것 {rejected.length}쌍</div>
          {rejected.map((p) => (
            <div key={`${p.a} ${p.b}`} style={S.rejectedRow}>
              <span style={S.rejectedPair}>
                {p.a} ↔ {p.b}
              </span>
              <button style={S.small} disabled={busy} onClick={() => onUnreject(p.a, p.b)}>
                되돌리기
              </button>
            </div>
          ))}
          <p style={S.note}>
            이 목록은 Vault 의 <code style={S.code}>.sb/dedup-rejected.json</code> 에 있습니다.{' '}
            <b>동기화가 올리지 않습니다</b> — CO 영역에서도 동료에게 가지 않습니다.
          </p>
        </section>
      )}
    </Shell>
  );
}

/** 레일 버튼. 후보가 있을 때만 개수를 붙인다 — 0 을 늘 띄워 두면 곧 안 보게 된다 */
export function DedupButton({
  count,
  busy,
  onClick,
  style,
}: {
  count: number | null;
  busy: boolean;
  onClick: () => void;
  /** 레일에서 옆 버튼들과 같은 폭·글자 크기로 맞출 때 넘긴다 */
  style?: React.CSSProperties;
}) {
  return (
    <button style={{ width: '100%', ...style }} disabled={busy} onClick={onClick} title="이름이 비슷한 페이지 쌍">
      중복 후보{count !== null && count > 0 ? ` ${count}` : ''}
    </button>
  );
}

const S = {
  note: {
    margin: '0 0 var(--s)', padding: 'var(--s)', borderRadius: 'var(--r-card)',
    background: 'var(--tint)', color: 'var(--fg-muted)', fontSize: '0.8125rem', lineHeight: 1.6,
  },
  dim: { color: 'var(--fg-faint)', fontSize: '0.875rem' },
  row: {
    padding: 'var(--s)', marginBottom: 6,
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-surface)',
  },
  pair: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  name: { fontWeight: 600 },
  arrow: { color: 'var(--fg-faint)' },
  why: { color: 'var(--fg-muted)', fontSize: '0.8125rem', marginTop: 4 },
  buttons: { display: 'flex', gap: 6, marginTop: 'var(--s)' },

  block: { marginTop: 20 },
  blockHead: { fontSize: '0.75rem', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 6 },
  rejectedRow: {
    display: 'flex', alignItems: 'center', gap: 'var(--s)',
    padding: '4px 0', fontSize: '0.875rem',
  },
  rejectedPair: { flex: 1, color: 'var(--fg-muted)', wordBreak: 'break-word' },
  small: { fontSize: '0.8125rem', padding: '2px 8px' },
  code: { fontFamily: 'var(--mono)', fontSize: '0.8125rem' },
} satisfies Record<string, React.CSSProperties>;
