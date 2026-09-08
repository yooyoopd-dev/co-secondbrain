// 설정과 나의 기준 맥락. 둘 다 겹침 화면이고 Debug.tsx 와 같은 껍데기를 쓴다.
//
// **판정은 여기서 하지 않는다.** 설치 여부도 저장도 main 이 한다. 이 파일은 받은 것을
// 그리고 고른 것을 넘길 뿐이다.
import { useEffect, useState } from 'react';
import type { AnswerWith, AppSettings, HubStatus, LocalInfo } from '../main/ipc.ts';
import type { LocalConfig } from '../core/local/ollama.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { CORE_CONTEXT_FIELDS, CORE_CONTEXT_PATH, type CoreContext } from '../core/context.ts';
import { Icon } from './icons.tsx';

export function SettingsPanel({
  settings,
  hub,
  local,
  busy,
  onProvider,
  onAnswerWith,
  onLocalConfig,
  onBuildVectors,
  onCore,
  onHub,
  onClose,
}: {
  settings: AppSettings;
  /** 허브 상태. Vault 를 안 열었으면 null 이고 그때는 동기화 줄을 안 그린다 */
  hub: HubStatus | null;
  /** 로컬 모델 상태. 네트워크를 타므로 늦게 오고, 오기 전에는 null 이다 */
  local: LocalInfo | null;
  busy: boolean;
  onProvider: (id: ProviderId | null) => void;
  onAnswerWith: (mode: AnswerWith) => void;
  onLocalConfig: (cfg: LocalConfig) => void;
  onBuildVectors: () => void;
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
            {/* 좌측 레일의 배지와 같은 값이어야 한다. 두 자리가 다르게 말하면 둘 다 못 믿는다 */}
            <Row label="종류" value={settings.co ? 'CO 영역' : '개인 Vault'} />
            {/* 경로는 길다. 줄바꿈을 막지 않는다 — 잘라 놓으면 옮겨 적을 수가 없다 */}
            <Row label="폴더" value={settings.vaultRoot} mono />
          </>
        )}
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

      <LocalBlock
        settings={settings}
        local={local}
        busy={busy}
        onAnswerWith={onAnswerWith}
        onLocalConfig={onLocalConfig}
        onBuildVectors={onBuildVectors}
      />
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

export function Shell({
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

/**
 * [위키에 묻기] 만 로컬 모델로 돌리는 자리.
 *
 * **공급자 목록의 넷째 항목이 아니다.** 위의 LLM CLI 설정은 예산을 쓰는 외부 CLI 중에서
 * 고르는 것이고 여기는 밖으로 보낼지 말지를 고른다. 위키 갱신은 이 값과 무관하게
 * 늘 CLI 가 맡는다 — 파일을 고치는 제안이라 작은 모델로 먼저 시험할 자리가 아니다
 * (docs/LOCAL-LLM.md §5 · §8).
 */
function LocalBlock({
  settings,
  local,
  busy,
  onAnswerWith,
  onLocalConfig,
  onBuildVectors,
}: {
  settings: AppSettings;
  local: LocalInfo | null;
  busy: boolean;
  onAnswerWith: (mode: AnswerWith) => void;
  onLocalConfig: (cfg: LocalConfig) => void;
  onBuildVectors: () => void;
}) {
  const [draft, setDraft] = useState<LocalConfig>(settings.local);
  useEffect(() => setDraft(settings.local), [settings.local]);
  const dirty =
    draft.host !== settings.local.host ||
    draft.chatModel !== settings.local.chatModel ||
    draft.embedModel !== settings.local.embedModel;

  return (
    <section style={S.block}>
      <div style={S.blockHead}>위키에 묻기</div>
      <Choice
        name="answerWith"
        checked={settings.answerWith === 'cli'}
        disabled={busy}
        onPick={() => onAnswerWith('cli')}
        label="LLM CLI — 위의 설정을 따른다"
        note="모델이 내장 MCP 서버로 위키를 직접 읽는다. 질문과 읽은 내용이 밖으로 나간다"
      />
      <Choice
        name="answerWith"
        checked={settings.answerWith === 'local'}
        disabled={busy}
        onPick={() => onAnswerWith('local')}
        label="로컬 모델 (Ollama)"
        note="앱이 위키에서 찾아 프롬프트에 넣고 이 컴퓨터의 모델을 한 번 부른다. 내용이 안 나가고 돈이 안 든다"
      />

      {settings.answerWith === 'local' && (
        <>
          <div style={S.rowButtons}>
            <LocalField label="주소" value={draft.host} disabled={busy} onChange={(host) => setDraft({ ...draft, host })} />
            <LocalField label="대화 모델" value={draft.chatModel} disabled={busy} onChange={(chatModel) => setDraft({ ...draft, chatModel })} />
            <LocalField label="임베딩 모델" value={draft.embedModel} disabled={busy} onChange={(embedModel) => setDraft({ ...draft, embedModel })} />
          </div>
          <div style={S.rowButtons}>
            <button disabled={busy || !dirty} onClick={() => onLocalConfig(draft)}>
              <Icon name="save" /> 저장
            </button>
            <button
              disabled={busy || !local?.status.ok || settings.vaultRoot === null}
              onClick={onBuildVectors}
            >
              임베딩 만들기
            </button>
          </div>

          {local === null ? (
            <div style={S.dim}>Ollama 에 물어보는 중입니다…</div>
          ) : local.status.ok ? (
            <p style={S.note}>
              {local.status.chat} · {local.status.embed} 를 찾았습니다. 위키 조각 {local.chunks}개 중
              임베딩이 {local.vectors}개 있습니다.
              {local.vectors === 0
                ? ' 임베딩이 없으면 키워드로만 찾습니다 — 답은 나오지만 바꿔 말한 질문에 약합니다.'
                : ''}
            </p>
          ) : (
            <p style={S.warn}>{local.status.error}</p>
          )}
        </>
      )}
    </section>
  );
}

/** 한 줄짜리 입력. 주소와 모델 이름만 받는다 */
function LocalField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label style={S.localField}>
      <span style={S.fieldHint}>{label}</span>
      <input type="text" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={S.localInput} />
    </label>
  );
}

/** 라디오 한 줄. 근거를 같이 보여준다 — 이름만 있으면 무엇이 다른지 모른다 */
function Choice({
  checked,
  disabled,
  onPick,
  label,
  note,
  name = 'provider',
}: {
  checked: boolean;
  disabled: boolean;
  onPick: () => void;
  label: string;
  note: string;
  /** 라디오 묶음 이름. 한 화면에 묶음이 둘이라 나눠야 한다 */
  name?: string;
}) {
  return (
    <label style={{ ...S.choice, opacity: disabled && !checked ? 0.5 : 1 }}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} />
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
  localField: { display: 'block', flex: '1 1 150px', minWidth: 120 },
  localInput: { width: '100%', fontFamily: 'var(--mono)', fontSize: '0.8125rem' },
} satisfies Record<string, React.CSSProperties>;
