// 마크다운 렌더링 뷰. 자르는 것은 core/md.ts 가 하고 여기는 그리기만 한다.
//
// **`dangerouslySetInnerHTML` 을 쓰지 않는다.** 원본에는 사람이 넣지 않은 HTML 이
// 섞여 있고 그것을 그대로 넣으면 위키가 주입 통로가 된다. core/md.ts 가 태그를 이미
// 글자로 내려 보낸다.
import { parseMarkdown, parseSnippet, type Block, type Inline } from '../core/md.ts';

export type MdView = 'render' | 'source';

/** 화면 두 곳(검색 결과·원문 뷰어)이 같은 값을 쓴다. 따로 두면 어느 쪽이 켜졌는지 헷갈린다 */
export function MdToggle({ view, onChange }: { view: MdView; onChange: (v: MdView) => void }) {
  return (
    <div style={S.toggle} role="group" aria-label="보기 방식">
      {(['render', 'source'] as const).map((v) => (
        <button
          key={v}
          style={{ ...S.toggleItem, ...(view === v ? S.toggleOn : null) }}
          aria-pressed={view === v}
          onClick={() => onChange(v)}
        >
          {v === 'render' ? '렌더링' : '원본'}
        </button>
      ))}
    </div>
  );
}

/** 블록까지 그린다. 원문 조각·위키 본문처럼 여러 줄인 글에 쓴다 */
export function Markdown({ text, view }: { text: string; view: MdView }) {
  if (view === 'source') return <pre style={S.source}>{text}</pre>;
  return (
    <div style={S.body}>
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}

/** 인라인만 그린다. 검색 조각처럼 문장 한 도막인 글에 쓴다 */
export function MarkdownSnippet({ text, view }: { text: string; view: MdView }) {
  if (view === 'source') return <span style={S.sourceInline}>{text}</span>;
  return (
    <span>
      <InlineView nodes={parseSnippet(text)} />
    </span>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'h': {
      const size = [0, 1.25, 1.125, 1, 0.9375, 0.875, 0.875][block.level] ?? 1;
      return (
        <div style={{ ...S.h, fontSize: `${size}rem` }}>
          <InlineView nodes={block.v} />
        </div>
      );
    }
    case 'p':
      return (
        <p style={S.p}>
          <InlineView nodes={block.v} />
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol style={S.list}>
          {block.items.map((it, i) => (
            <li key={i} style={S.li}>
              <InlineView nodes={it} />
            </li>
          ))}
        </ol>
      ) : (
        <ul style={S.list}>
          {block.items.map((it, i) => (
            <li key={i} style={S.li}>
              <InlineView nodes={it} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote style={S.quote}>
          <InlineView nodes={block.v} />
        </blockquote>
      );
    case 'code':
      return <pre style={S.code}>{block.v}</pre>;
    case 'hr':
      return <hr style={S.hr} />;
    case 'table':
      // 넓은 표는 자기 안에서만 옆으로 흐른다. 본문이 통째로 밀리면 못 읽는다.
      return (
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                {block.head.map((c, i) => (
                  <th key={i} style={{ ...S.cell, ...S.th }}>
                    <InlineView nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={S.cell}>
                      <InlineView nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** 링크는 글자로만 그린다. 앱에는 밖으로 나가는 통로가 없다 (README "의도적으로 없는 것") */
function InlineView({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <span key={i}>{n.v}</span>;
          case 'code':
            return (
              <code key={i} style={S.inlineCode}>
                {n.v}
              </code>
            );
          case 'strong':
            return (
              <strong key={i}>
                <InlineView nodes={n.v} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={n.v} />
              </em>
            );
          case 'link':
            return (
              <span key={i} style={S.link} title={n.href}>
                <InlineView nodes={n.v} />
              </span>
            );
        }
      })}
    </>
  );
}

const S = {
  toggle: { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', overflow: 'hidden' },
  toggleItem: {
    border: 0, borderRadius: 0, padding: '2px 10px', fontSize: '0.75rem',
    background: 'var(--bg-canvas)', color: 'var(--fg-muted)',
  },
  toggleOn: { background: 'var(--bg-raised)', color: 'var(--fg)', fontWeight: 600 },

  body: { lineHeight: 1.65 },
  source: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: '0.75rem' },
  sourceInline: { fontFamily: 'var(--mono)', fontSize: '0.75rem' },

  h: { fontWeight: 600, margin: '12px 0 4px' },
  p: { margin: '0 0 8px', whiteSpace: 'pre-wrap' },
  list: { margin: '0 0 8px', paddingLeft: '1.3em' },
  li: { marginBottom: 2 },
  quote: {
    margin: '0 0 8px', padding: '2px 10px', borderLeft: '3px solid var(--border-strong)',
    color: 'var(--fg-muted)',
  },
  code: {
    margin: '0 0 8px', padding: 'var(--s)', overflowX: 'auto',
    background: 'var(--bg-canvas)', border: '1px solid var(--border)', borderRadius: 'var(--r-input)',
    fontFamily: 'var(--mono)', fontSize: '0.75rem', lineHeight: 1.5,
  },
  inlineCode: { fontFamily: 'var(--mono)', fontSize: '0.8125em', background: 'var(--bg-canvas)', padding: '0 4px', borderRadius: 3 },
  hr: { border: 0, borderTop: '1px solid var(--border)', margin: '12px 0' },
  link: { color: 'var(--info)', textDecoration: 'underline', textUnderlineOffset: 2 },

  tableWrap: { overflowX: 'auto', marginBottom: 8 },
  table: { borderCollapse: 'collapse', fontSize: '0.8125rem' },
  cell: { border: '1px solid var(--border)', padding: '3px 8px', textAlign: 'left', verticalAlign: 'top' },
  th: { background: 'var(--bg-canvas)', fontWeight: 600 },
} satisfies Record<string, React.CSSProperties>;
