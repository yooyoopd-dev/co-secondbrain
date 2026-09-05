// 관문 8 — 사람의 diff 승인 화면. DESIGN-SYSTEM.md "Diff 검토 카드"
//
// **판정은 여기서 하지 않는다.** 승인 가능 여부·위반·충돌은 전부 core/review.ts 가 계산하고
// 이 파일은 그리기만 한다. 그래야 관문 판정이 테스트로 고정된다.
import { useState } from 'react';
import { sideBySide, type DiffRow } from '../core/diff.ts';
import { applyBlockReason } from '../core/approve.ts';
import type { OpReview, Review } from '../core/review.ts';
import type { Claim } from '../core/page.ts';

const OP_LABEL = { create: '신규', update: '수정', delete: '삭제' } as const;

export default function ReviewOverlay({
  review,
  busy,
  onApply,
  onCancel,
  onJump,
  onEdit,
}: {
  review: Review;
  busy: boolean;
  onApply: (approved: string[]) => void;
  onCancel: () => void;
  onJump: (sourceId: string, locator: string) => void;
  /** 고친 내용을 저장하면 관문을 다시 돌린 검토 결과가 온다 */
  onEdit: (path: string, content: string) => void;
}) {
  // 문제가 있는 카드는 처음부터 보류다. 사람이 일부러 승인 목록에 넣어야 한다.
  const [approved, setApproved] = useState<string[]>(() =>
    review.ops.filter((o) => o.violations.length === 0 && o.conflict === null).map((o) => o.op.path),
  );

  const blocked = applyBlockReason(review, approved);
  const toggle = (p: string) => setApproved((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <div style={S.scrim} role="dialog" aria-label="변경안 검토">
      <div style={S.panel} className="enter">
        <header style={S.head}>
          <div>
            <div style={S.title}>{review.summary}</div>
            <div style={S.meta}>
              페이지 {review.ops.length}건 · 승인 {approved.length} · 보류 {review.ops.length - approved.length}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--s)', alignItems: 'center' }}>
            {blocked && <span style={S.blocked}>{blocked}</span>}
            <button disabled={busy} onClick={onCancel}>
              버리기
            </button>
            <button className="primary" disabled={busy || blocked !== null} onClick={() => onApply(approved)}>
              {approved.length}건 적용
            </button>
          </div>
        </header>

        <div style={S.body}>
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
    <section style={{ ...S.card, borderColor: flagged ? 'var(--danger)' : approved ? 'var(--border-strong)' : 'var(--border)' }}>
      <div style={S.cardHead}>
        <span style={S.opTag}>{OP_LABEL[op.op.op]}</span>
        <span style={S.cardTitle}>{op.title}</span>
        <span style={S.path}>{op.op.path}</span>
        <span style={S.stat}>
          <span style={{ color: 'var(--ok)' }}>+{op.added}</span> <span style={{ color: 'var(--danger)' }}>−{op.deleted}</span>
        </span>
      </div>

      {op.conflict && <div style={S.danger}>{op.conflict}</div>}
      {op.violations.map((v, i) => (
        <div key={i} style={S.danger}>
          관문 {v.gate} — {v.reason}
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
        <label style={S.check}>
          <input type="checkbox" checked={approved} onChange={onToggle} />
          {approved ? '승인' : '보류'}
        </label>
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
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)',
    display: 'grid', placeItems: 'center', padding: 24, zIndex: 10,
  },
  panel: {
    display: 'flex', flexDirection: 'column', width: 'min(1100px, 100%)', height: '100%',
    background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflow: 'hidden',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s)',
    padding: 'var(--s)', borderBottom: '1px solid var(--border)',
  },
  title: { fontWeight: 600 },
  meta: { fontSize: '0.8125rem', color: 'var(--fg-muted)' },
  blocked: { fontSize: '0.8125rem', color: 'var(--warn)', maxWidth: 280, textAlign: 'right' },
  body: { overflowY: 'auto', flex: 1, padding: 'var(--s)' },

  discussion: {
    margin: '0 0 var(--s)', padding: 'var(--s)', borderLeft: '3px solid var(--info)',
    background: 'var(--bg-raised)', color: 'var(--fg-muted)', fontSize: '0.875rem',
  },
  discussionLabel: { fontSize: '0.75rem', color: 'var(--fg-faint)', marginBottom: 4 },

  card: { border: '1px solid var(--border)', borderRadius: 'var(--r-card)', background: 'var(--bg-raised)', padding: 'var(--s)', marginBottom: 'var(--s)' },
  cardHead: { display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', gap: 'var(--s)', alignItems: 'baseline' },
  opTag: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', color: 'var(--fg-faint)', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '1px 5px' },
  cardTitle: { fontWeight: 600 },
  path: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--fg-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stat: { fontFamily: 'var(--mono)', fontSize: '0.75rem' },

  danger: { marginTop: 6, padding: 6, borderRadius: 'var(--r-input)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: '0.8125rem' },

  claims: { listStyle: 'none', margin: '10px 0 0', padding: 0, fontSize: '0.875rem' },
  claim: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 4 },
  badge: { fontFamily: 'var(--mono)', fontSize: '0.6875rem', border: '1px solid', borderRadius: 4, padding: '0 5px', whiteSpace: 'nowrap' },

  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--info)', border: '1px solid var(--border)', padding: '1px 6px', background: 'transparent' },
  chipBroken: { color: 'var(--danger)', borderColor: 'var(--danger)', textDecoration: 'line-through', cursor: 'not-allowed' },

  diff: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 1px', marginTop: 10,
    fontFamily: 'var(--mono)', fontSize: '0.75rem', background: 'var(--border)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-input)', overflow: 'hidden',
  },
  diffHead: { background: 'var(--bg-surface)', color: 'var(--fg-faint)', padding: '3px 8px' },
  line: { background: 'var(--bg-canvas)', padding: '1px 8px', borderLeft: '3px solid transparent', whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.5em' },
  add: { borderLeftColor: 'var(--ok)', background: '#0c1a0f' },
  del: { borderLeftColor: 'var(--danger)', background: '#1c0f0f' },

  cardFoot: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' },
  editor: {
    width: '100%', minHeight: 260, marginTop: 10, padding: 'var(--s)', resize: 'vertical',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5,
    background: 'var(--bg-canvas)', color: 'var(--fg)',
    border: '1px solid var(--border-strong)', borderRadius: 'var(--r-input)',
  },
  check: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.875rem', cursor: 'pointer' },
} satisfies Record<string, React.CSSProperties>;
