// 설정과 나의 기준 맥락. 둘 다 겹침 화면이고 Debug.tsx 와 같은 껍데기를 쓴다.
//
// **판정은 여기서 하지 않는다.** 설치 여부도 저장도 main 이 한다. 이 파일은 받은 것을
// 그리고 고른 것을 넘길 뿐이다.
import { useEffect, useState } from 'react';
import type { AppSettings, HubStatus } from '../main/ipc.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { CORE_CONTEXT_FIELDS, CORE_CONTEXT_PATH, type CoreContext } from '../core/context.ts';
import { Icon } from './icons.tsx';

export function SettingsPanel({
  settings,
  hub,
  busy,
  onProvider,
  onOpenVault,
  onCloseVault,
  onCore,
  onHub,
  onClose,
}: {
  settings: AppSettings;
  /** 허브 상태. Vault 를 안 열었으면 null 이고 그때는 동기화 줄을 안 그린다 */
  hub: HubStatus | null;
  busy: boolean;
  onProvider: (id: ProviderId | null) => void;
  onOpenVault: () => void;
  onCloseVault: () => void;
  onCore: () => void;
  onHub: () => void;
  onClose: () => void;
}) {
  return (
    <Shell title="설정" version={settings.version} busy={busy} onClose={onClose}>
      <section style={S.block}>
        <div style={S.blockHead}>Vault</div>
        {settings.vaultRoot === null ? (
          <div style={S.dim}>아직 안 열었습니다.</div>
        ) : (
          <>
            <Row label="이름" value={settings.vaultTitle ?? ''} />
            <Row label="종류" value={settings.personal ? '개인 Vault' : 'CO 영역'} />
            {/* 경로는 길다. 줄바꿈을 막지 않는다 — 잘라 놓으면 옮겨 적을 수가 없다 */}
            <Row label="폴더" value={settings.vaultRoot} mono />
          </>
        )}
        <div style={S.rowButtons}>
          <button disabled={busy} onClick={onOpenVault}>
            다른 Vault 열기
          </button>
          <button disabled={busy || settings.vaultRoot === null} onClick={onCloseVault}>
            Vault선택
          </button>
        </div>
      </section>

      <section style={S.block}>
        <div style={S.blockHead}>맥락과 연결</div>
        <div style={S.rowButtons}>
          <button disabled={busy || settings.vaultRoot === null} onClick={onCore}>
            <Icon name="user" /> 나의 핵심 맥락
          </button>
          {/* 개인 Vault 에는 허브가 없다. 눌러도 할 것이 없는 버튼은 안 그린다 */}
          {hub && !hub.personal && (
            <button disabled={busy} onClick={onHub}>
              {hub.hasToken ? '허브 동기화' : '허브 연결'}
            </button>
          )}
        </div>
        {hub?.personal && <div style={S.dim}>개인 Vault 는 동기화가 없습니다. 내용이 이 컴퓨터를 떠나지 않습니다.</div>}
      </section>

      <section style={S.block}>
        <div style={S.blockHead}>LLM CLI 설정</div>
        <p style={S.note}>
          설치 여부는 앱을 켤 때 한 번 봅니다. 방금 설치했다면 앱을 다시 켜야 목록에 뜹니다.
        </p>
        <Choice
          checked={settings.provider === null}
          disabled={busy}
          onPick={() => onProvider(null)}
          label="자동 — 작업 종류별로 고른다"
          note="인제스트 배치는 상한이 느슨한 쪽으로, 질의와 종합은 판단이 좋은 쪽으로 보낸다"
        />
        {settings.providers.map((p) => (
          <Choice
            key={p.id}
            checked={settings.provider === p.id}
            disabled={busy || !p.installed}
            onPick={() => onProvider(p.id)}
            label={p.label}
            note={p.installed ? p.note : `${p.note} · 이 PC 에서 못 찾았습니다`}
          />
        ))}
        {settings.provider !== null && (
          <p style={S.warn}>
            하나로 고정하면 그 CLI 가 못 맞추는 작업은 다른 데로 넘기지 않고 거절합니다.
            왜 결과가 달라졌는지 모르는 것보다 안 도는 편이 낫기 때문입니다.
          </p>
        )}
      </section>
    </Shell>
  );
}

/** 세 문항. 적은 것이 LLM 호출 앞머리에 그대로 들어간다 (core/context.ts) */
export function CoreContextPanel({
  value,
  busy,
  onSave,
  onClose,
}: {
  value: CoreContext;
  busy: boolean;
  onSave: (ctx: CoreContext) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CoreContext>(value);
  // 화면이 열려 있는 동안 파일이 다시 읽히면 따라간다
  useEffect(() => setDraft(value), [value]);
  const dirty = CORE_CONTEXT_FIELDS.some((f) => draft[f.key] !== value[f.key]);

  return (
    <Shell title="나의 핵심 맥락" busy={busy} onClose={onClose}>
      <p style={S.note}>
        LLM 이 매 호출에서 먼저 읽습니다. 같은 원본이라도 누가 왜 쌓는지 알면 고르는 것이
        달라집니다. Vault 의 <code style={S.code}>{CORE_CONTEXT_PATH}</code> 파일 하나가 정본이라
        Obsidian 에서 바로 고쳐도 됩니다. <b>동기화는 이 파일을 올리지 않습니다</b> —
        CO 영역에서도 동료에게 가지 않습니다.
      </p>

      {CORE_CONTEXT_FIELDS.map((f, i) => (
        <label key={f.key} style={S.field}>
          <span style={S.fieldLabel}>
            {i + 1}. {f.label}
          </span>
          <span style={S.fieldHint}>
            {f.heading} · {f.hint}
          </span>
          <textarea
            rows={4}
            disabled={busy}
            value={draft[f.key]}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            style={S.textarea}
          />
        </label>
      ))}

      <div style={S.rowButtons}>
        <button className="primary" disabled={busy || !dirty} onClick={() => onSave(draft)}>
          <Icon name="save" /> 저장
        </button>
        <button disabled={busy || !dirty} onClick={() => setDraft(value)}>
          되돌리기
        </button>
      </div>
    </Shell>
  );
}

/* ---------- 공통 껍데기 ---------- */

function Shell({
  title,
  version,
  busy,
  onClose,
  children,
}: {
  title: string;
  /** 있으면 제목 옆에 붙는다. 판 번호는 물어볼 일이 있을 때 바로 보여야 한다 */
  version?: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={S.scrim} role="dialog" aria-label={title}>
      <div style={S.panel} className="enter">
        <header style={S.head}>
          <div style={S.titleRow}>
            <span style={S.title}>{title}</span>
            {version && <span style={S.version}>앱 버전 v{version}</span>}
          </div>
          <button aria-label="닫기" disabled={busy} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div style={S.body} className="stagger">
          {children}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={mono ? S.rowValueMono : S.rowValue}>{value}</span>
    </div>
  );
}

/** 라디오 한 줄. 근거를 같이 보여준다 — 이름만 있으면 무엇이 다른지 모른다 */
function Choice({
  checked,
  disabled,
  onPick,
  label,
  note,
}: {
  checked: boolean;
  disabled: boolean;
  onPick: () => void;
  label: string;
  note: string;
}) {
  return (
    <label style={{ ...S.choice, opacity: disabled && !checked ? 0.5 : 1 }}>
      <input type="radio" name="provider" checked={checked} disabled={disabled} onChange={onPick} />
      <span>
        <span style={S.choiceLabel}>{label}</span>
        <span style={S.choiceNote}>{note}</span>
      </span>
    </label>
  );
}

const S = {
  scrim: {
    position: 'fixed', inset: 0, background: 'rgba(28,28,28,0.28)',
    display: 'grid', placeItems: 'center', padding: 24, zIndex: 10,
  },
  panel: {
    display: 'flex', flexDirection: 'column', width: 'min(640px, 100%)', maxHeight: '100%',
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-modal)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden',
  },
  head: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s)',
    padding: 'var(--s)', borderBottom: '1px solid var(--border)',
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: 'var(--s)', minWidth: 0 },
  title: { fontWeight: 600 },
  version: { fontSize: '0.8125rem', color: 'var(--fg-faint)', fontFamily: 'var(--mono)' },
  body: { overflowY: 'auto', padding: 'var(--s)' },

  block: { marginBottom: 20 },
  // 대문자 변환을 안 쓴다. 한글 머리말은 안 바뀌고 라틴 머리말만 소리쳐서 짝이 안 맞는다.
  blockHead: { fontSize: '0.75rem', letterSpacing: '0.04em', color: 'var(--fg-faint)', marginBottom: 6 },
  row: { display: 'grid', gridTemplateColumns: '80px 1fr', gap: 'var(--s)', padding: '4px 0', fontSize: '0.875rem' },
  rowLabel: { color: 'var(--fg-muted)' },
  rowValue: { wordBreak: 'break-word' },
  rowValueMono: { fontFamily: 'var(--mono)', fontSize: '0.8125rem', wordBreak: 'break-all' },
  rowButtons: { display: 'flex', gap: 6, marginTop: 'var(--s)', flexWrap: 'wrap' },
  dim: { color: 'var(--fg-faint)', fontSize: '0.875rem' },

  note: {
    margin: '0 0 var(--s)', padding: 'var(--s)', borderRadius: 'var(--r-card)',
    background: 'var(--tint)', color: 'var(--fg-muted)', fontSize: '0.8125rem', lineHeight: 1.6,
  },
  warn: {
    margin: 'var(--s) 0 0', padding: 'var(--s)', borderRadius: 'var(--r-card)',
    background: 'var(--info-wash)', color: 'var(--fg-muted)', fontSize: '0.8125rem', lineHeight: 1.6,
  },
  code: { fontFamily: 'var(--mono)', fontSize: '0.8125rem' },

  choice: { display: 'flex', gap: 'var(--s)', alignItems: 'flex-start', padding: '7px 0', cursor: 'pointer' },
  choiceLabel: { display: 'block', fontSize: '0.875rem' },
  choiceNote: { display: 'block', fontSize: '0.8125rem', color: 'var(--fg-muted)', marginTop: 2 },

  field: { display: 'block', marginBottom: 'var(--s)' },
  fieldLabel: { display: 'block', fontSize: '0.875rem', fontWeight: 600 },
  fieldHint: { display: 'block', fontSize: '0.8125rem', color: 'var(--fg-faint)', margin: '2px 0 6px' },
  textarea: { width: '100%', resize: 'vertical', lineHeight: 1.6 },
} satisfies Record<string, React.CSSProperties>;
