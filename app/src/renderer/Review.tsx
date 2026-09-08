// 관문 8 — 사람의 diff 승인 화면. DESIGN-SYSTEM.md "Diff 검토 카드"
//
// **판정은 여기서 하지 않는다.** 승인 가능 여부·위반·충돌은 전부 core/review.ts 가 계산하고
// 이 파일은 그리기만 한다. 그래야 관문 판정이 테스트로 고정된다.
import { useRef, useState } from 'react';
import { sideBySide, type DiffRow } from '../core/diff.ts';
import { applyBlocker, dropFlagged } from '../core/approve.ts';
import type { OpReview, Review } from '../core/review.ts';
import type { Claim } from '../core/page.ts';
import { Icon } from './icons.tsx';

const OP_LABEL = { create: '신규', update: '수정', delete: '삭제' } as const;

/**
 * 관문이 막았을 때 사람이 다음에 할 일. **사유만 적으면 오류처럼 보인다** —
 * 실제로 "관문 5 — 없는 앵커를 인용했습니다" 를 보고 무엇을 해야 할지 몰랐다.
 */
const GATE_FIX: Record<number, string> = {
  1: '변경안 모양이 어긋났습니다. 이 페이지는 보류하고 다시 제안하십시오.',
  2: '쓸 수 있는 자리는 02_NOTES 아래뿐입니다. 이 페이지는 보류하십시오.',
  3: '파일명이 안전하지 않습니다. 이 페이지는 보류하십시오.',
  4: '출처 없는 주장이 있습니다. [편집] 으로 근거를 붙이거나 그 문장을 지우십시오.',
  5: 'LLM 이 원본에 없는 자리를 인용했습니다. [편집] 으로 그 인용을 지우거나 맞는 앵커로 고치십시오. 원본을 안 고쳐도 됩니다.',
  9: '열람 등급이 원본보다 낮습니다. [편집] 으로 앞머리의 classification 을 올리십시오.',
};

export default function ReviewOverlay({
  review,
  busy,
  initialApproved,
  onApply,
  onHold,
  onCancel,
  onJump,
  onEdit,
  onRepair,
}: {
  review: Review;
  busy: boolean;
  /** 보류해 둔 것을 다시 열 때 그때 골라 둔 목록. 처음 열 때는 없다 */
  initialApproved?: readonly string[];
  onApply: (approved: string[]) => void;
  /** 지금 고른 것을 그대로 두고 나간다 */
  onHold: (approved: string[]) => void;
  onCancel: () => void;
  onJump: (sourceId: string, locator: string) => void;
  /** 고친 내용을 저장하면 관문을 다시 돌린 검토 결과가 온다 */
  onEdit: (path: string, content: string) => void;
  /** 없는 앵커 인용을 한 번에 지운다. 관문은 그대로 다시 돈다 */
  onRepair: () => void;
}) {
  // 문제가 있는 카드는 처음부터 보류다. 사람이 일부러 승인 목록에 넣어야 한다.
  const [approved, setApproved] = useState<string[]>(() =>
    initialApproved
      ? review.ops.filter((o) => initialApproved.includes(o.op.path)).map((o) => o.op.path)
      : review.ops.filter((o) => o.violations.length === 0 && o.conflict === null).map((o) => o.op.path),
  );
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const blocked = applyBlocker(review, approved);
  // 관문 5 만 따로 센다. 이것만은 앱이 대신 지울 수 있다 — 나머지 위반은 사람이 판단해야 한다
  const badAnchors = review.ops.reduce((n, o) => n + o.violations.filter((x) => x.gate === 5).length, 0);
  const flagged = approved.length - dropFlagged(review, approved).length;
  const toggle = (p: string) => setApproved((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  /** 막는 카드로 데려간다. 사유만 읽고 어느 것인지 못 찾는 일이 실제로 있었다 */
  const focusBlocker = (path: string) => {
    const el = bodyRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div style={S.scrim} role="dialog" aria-label="변경안 검토">
      <div style={S.panel} className="enter">
        <header style={S.head}>
          <div>
            <div style={S.title}>{review.summary}</div>
            <div style={S.meta}>
              페이지 {review.ops.length}건 · 승인 {approved.length} · 보류 {review.ops.length - approved.length}
              {flagged > 0 && <span style={{ color: 'var(--warn)' }}> · 문제 있는데 승인 {flagged}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s)', alignItems: 'center' }}>
            {blocked &&
              (blocked.path ? (
                <button style={S.blocked} onClick={() => focusBlocker(blocked.path!)} title="그 페이지로 이동">
                  {blocked.reason}
                </button>
              ) : (
                <span style={S.blockedText}>{blocked.reason}</span>
              ))}
            {badAnchors > 0 && (
              <button
                disabled={busy}
                onClick={onRepair}
                title="원본에 없는 앵커 인용을 지웁니다. 관문은 그대로 다시 돕니다"
              >
                없는 앵커 {badAnchors}건 지우기
              </button>
            )}
            {flagged > 0 && (
              <button disabled={busy} onClick={() => setApproved(dropFlagged(review, approved))}>
                문제 있는 {flagged}건 빼기
              </button>
            )}
            <button
              style={S.iconButton}
              disabled={busy}
              title="버리기"
              aria-label="버리기"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" />
            </button>
            <button disabled={busy} onClick={() => onHold(approved)} title="지금 고른 것을 그대로 두고 나갑니다">
              전체 보류
            </button>
            <button className="primary" disabled={busy || blocked !== null} onClick={() => onApply(approved)}>
              {approved.length}건 적용
            </button>
          </div>
        </header>

        {confirming && (
          <div style={S.confirm}>
            <span>
              변경안 {review.ops.length}건을 버립니다. 되돌릴 수 없고, 다시 받으려면 CLI 를 또 불러야 합니다.
              나갔다가 이어서 보려면 [전체 보류] 를 쓰십시오.
            </span>
            <span style={{ flex: 1 }} />
            <button disabled={busy} onClick={() => setConfirming(false)}>
              그만두기
            </button>
            <button style={S.dangerButton} disabled={busy} onClick={onCancel}>
              <Icon name="trash" /> 버립니다
            </button>
          </div>
        )}

        <div style={S.body} ref={bodyRef}>
          {review.globalViolations.map((v, i) => (
            <div key={i} style={S.danger}>
              {v.reason}
            </div>
          ))}

          {review.discussion && (
            <blockquote style={S.discussion}>
              <div style={S.discussionLabel}>물어본 것</div>
              {review.discussion}
            </blockquote>
          )}

          {review.ops.map((o) => (
            <Card
              key={o.op.path}
              op={o}
              approved={approved.includes(o.op.path)}
              busy={busy}
              onToggle={() => toggle(o.op.path)}
              onJump={onJump}
              onEdit={onEdit}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({
  op,
  approved,
  busy,
  onToggle,
  onJump,
  onEdit,
}: {
  op: OpReview;
  approved: boolean;
  busy: boolean;
  onToggle: () => void;
  onJump: (sourceId: string, locator: string) => void;
  onEdit: (path: string, content: string) => void;
}) {
  const rows = sideBySide(op.diff);
  const flagged = op.violations.length > 0 || op.conflict !== null;
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <section
      data-path={op.op.path}
      style={{ ...S.card, borderColor: flagged ? 'var(--danger)' : approved ? 'var(--border-strong)' : 'var(--border)' }}
    >
      <div style={S.cardHead}>
        <span style={S.opTag}>{OP_LABEL[op.op.op]}</span>
        <span style={S.cardTitle}>{op.title}</span>
        <span style={S.path}>{op.op.path}</span>
        <span style={S.stat}>
          <span style={{ color: 'var(--ok)' }}>+{op.added}</span> <span style={{ color: 'var(--danger)' }}>−{op.deleted}</span>
        </span>
      </div>

      {/*
        관문 지적은 오류가 아니라 **막힌 사유**다. 빨간 칸만 있으면 앱이 고장 난 것처럼
        보여서, 무엇을 하면 풀리는지 한 줄을 같이 적는다.
      */}
      {op.conflict && (
        <div style={S.blockNote}>
          <div style={S.blockWhat}>{op.conflict}</div>
          <div style={S.blockHow}>다시 제안하거나 이 페이지를 보류하십시오.</div>
        </div>
      )}
      {op.violations.map((v, i) => (
        <div key={i} style={S.blockNote}>
          <div style={S.blockWhat}>
            관문 {v.gate} — {v.reason}
          </div>
          <div style={S.blockHow}>{GATE_FIX[v.gate] ?? '이 페이지를 보류하면 나머지는 그대로 적용됩니다.'}</div>
        </div>
      ))}

      {op.claims.length > 0 && (
        <ul style={S.claims}>
          {op.claims.map((c, i) => (
            <li key={i} style={S.claim}>
              <ConfidenceBadge claim={c} />
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      )}

      {op.citations.length > 0 && (
        <div style={S.chips}>
          {op.citations.map((c) => (
            <button
              key={`${c.sourceId}#${c.locator}`}
              style={{ ...S.chip, ...(c.ok ? null : S.chipBroken) }}
              title={c.ok ? '원문으로 이동' : '원본에 없는 앵커입니다'}
              disabled={!c.ok}
              onClick={() => onJump(c.sourceId, c.locator)}
            >
              {c.sourceId}#{c.locator}
            </button>
          ))}
        </div>
      )}

      {draft === null ? (
        <DiffTable rows={rows} />
      ) : (
        <textarea
          style={S.editor}
          value={draft}
          spellCheck={false}
          aria-label={`${op.title} 편집`}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}

      <div style={S.cardFoot}>
        {/*
          체크박스는 "켜면 무엇이 되는지" 가 안 보였다. 두 칸을 다 그려서 지금 어느
          쪽인지와 누르면 어디로 가는지를 같이 보이게 한다.
        */}
        <div style={S.switch} role="group" aria-label={`${op.title} 승인 여부`}>
          <button
            style={{ ...S.switchItem, ...(approved ? null : S.switchHold) }}
            aria-pressed={!approved}
            disabled={busy}
            onClick={() => approved && onToggle()}
          >
            보류
          </button>
          <button
            style={{ ...S.switchItem, ...(approved ? S.switchOk : null) }}
            aria-pressed={approved}
            disabled={busy}
            onClick={() => !approved && onToggle()}
          >
            승인
          </button>
        </div>
        {flagged && approved && <span style={S.flaggedHint}>문제가 있어 이대로는 적용되지 않습니다</span>}
        <span style={{ flex: 1 }} />
        {draft === null ? (
          // 삭제는 고칠 내용이 없다
          op.after !== null && (
            <button disabled={busy} onClick={() => setDraft(op.after ?? '')}>
              편집
            </button>
          )
        ) : (
          <>
            <button disabled={busy} onClick={() => setDraft(null)}>
              편집 취소
            </button>
            <button
              disabled={busy || draft === op.after}
              onClick={() => {
                onEdit(op.op.path, draft);
                setDraft(null);
              }}
            >
              고쳐서 반영
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** 기본값(EXTRACTED)에는 배지를 안 붙인다. 그래야 낮은 신뢰도가 눈에 띈다. */
function ConfidenceBadge({ claim }: { claim: Claim }) {
  if (claim.confidence === 'EXTRACTED') return null;
  const danger = claim.confidence === 'AMBIGUOUS';
  return (
    <span style={{ ...S.badge, color: danger ? 'var(--danger)' : 'var(--warn)', borderColor: danger ? 'var(--danger)' : 'var(--warn)' }}>
      {danger ? '불확실' : `추론 ${claim.score ?? ''}`}
    </span>
  );
}

function DiffTable({ rows }: { rows: readonly DiffRow[] }) {
  return (
    <div style={S.diff}>
      <div style={S.diffHead}>현재</div>
      <div style={S.diffHead}>제안</div>
      {rows.map((r, i) => (
        <DiffPair key={i} row={r} />
      ))}
    </div>
  );
}

function DiffPair({ row }: { row: DiffRow }) {
  return (
    <>
      <div style={{ ...S.line, ...(row.left?.kind === 'del' ? S.del : null) }}>{row.left?.text ?? ''}</div>
      <div style={{ ...S.line, ...(row.right?.kind === 'add' ? S.add : null) }}>{row.right?.text ?? ''}</div>
    </>
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
  blocked: {
    fontSize: '0.8125rem', color: 'var(--warn)', maxWidth: 280, textAlign: 'right',
    background: 'transparent', border: 0, borderBottom: '1px dashed var(--warn)', borderRadius: 0, padding: 0,
  },
  blockedText: { fontSize: '0.8125rem', color: 'var(--warn)', maxWidth: 280, textAlign: 'right' },
  iconButton: { display: 'inline-flex', alignItems: 'center', padding: '4px 8px' },
  dangerButton: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    color: 'var(--danger)', borderColor: 'var(--danger)',
  },
  confirm: {
    display: 'flex', gap: 'var(--s)', alignItems: 'center', padding: 'var(--s)',
    borderBottom: '1px solid var(--border)', background: 'var(--danger-wash)',
    color: 'var(--fg)', fontSize: '0.875rem',
  },
  body: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },

  discussion: {
    margin: '0 0 var(--s)', padding: 'var(--s)', borderLeft: '3px solid var(--info)',
    background: 'var(--info-wash)', color: 'var(--fg-muted)', fontSize: '0.875rem',
  },
  discussionLabel: { fontSize: '0.75rem', color: 'var(--fg-faint)', marginBottom: 4 },

  card: {
    border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)',
    padding: 'var(--s)', marginBottom: 'var(--s)', boxShadow: 'var(--shadow-card)',
  },
  cardHead: { display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', gap: 'var(--s)', alignItems: 'baseline' },
  opTag: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '1px 8px' },
  cardTitle: { fontWeight: 600 },
  path: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stat: { fontFamily: 'var(--mono)', fontSize: '0.75rem' },

  danger: { marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-input)', border: '1px solid var(--danger)', background: 'var(--danger-wash)', color: 'var(--danger)', fontSize: '0.8125rem' },

  claims: { listStyle: 'none', margin: '10px 0 0', padding: 0, fontSize: '0.875rem' },
  claim: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 },
  badge: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', border: '1px solid', borderRadius: 'var(--r-pill)', padding: '0 8px', whiteSpace: 'nowrap' },

  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)', border: '1px solid var(--border)', padding: '1px 8px', background: 'var(--bg-canvas)' },
  chipBroken: { color: 'var(--danger)', borderColor: 'var(--danger)', textDecoration: 'line-through', cursor: 'not-allowed' },

  diff: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1px', marginTop: 10,
    fontFamily: 'var(--mono)', fontSize: '0.75rem', background: 'var(--border)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-input)', overflow: 'hidden',
  },
  diffHead: { background: 'var(--bg-canvas)', color: 'var(--fg-muted)', padding: '3px 8px' },
  line: { background: 'var(--bg-raised)', padding: '1px 8px', borderLeft: '3px solid transparent', whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.5em' },
  add: { borderLeftColor: 'var(--ok)', background: 'var(--ok-wash)' },
  del: { borderLeftColor: 'var(--danger)', background: 'var(--danger-wash)' },

  cardFoot: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' },
  editor: {
    width: '100%', minHeight: 260, marginTop: 10, padding: 'var(--s)', resize: 'vertical',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5,
    background: 'var(--bg-raised)', color: 'var(--fg)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-input)',
  },
  switch: { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', overflow: 'hidden' },
  switchItem: {
    border: 0, borderRadius: 0, padding: '3px 14px', fontSize: '0.8125rem',
    background: 'var(--bg-canvas)', color: 'var(--fg-faint)',
  },
  switchHold: { background: 'var(--bg-raised)', color: 'var(--fg-muted)', fontWeight: 600 },
  switchOk: { background: 'var(--ok-wash)', color: 'var(--ok)', fontWeight: 600 },
  flaggedHint: { fontSize: '0.75rem', color: 'var(--warn)' },

  blockNote: {
    marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-input)',
    border: '1px solid var(--warn)', background: 'var(--warn-wash)', fontSize: '0.8125rem',
  },
  blockWhat: { color: 'var(--warn)', fontWeight: 600 },
  blockHow: { color: 'var(--fg-muted)', marginTop: 2 },
} satisfies Record<string, React.CSSProperties>;
