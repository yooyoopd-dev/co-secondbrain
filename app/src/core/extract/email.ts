// 이메일 — 본문 + In-Reply-To/References 로 복원한 스레드 트리.
// M0 §3.1: 입력 순서를 섞어도 정확히 복원된다. LLM 없이 무료로 동작한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { Chunk, Extraction, Relation } from '../types.ts';

export interface MailMeta {
  sourceId: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: string;
  date: string | null;
}

const norm = (v: unknown) => String(v ?? '').replace(/[<>]/g, '').trim();

/** @kenjiuno/msgreader 의 최소 형태. 이 파일에서 쓰는 필드만 적는다. */
interface MsgReaderCtor {
  new (buf: ArrayBuffer): {
    getFileData(): {
      subject?: string; senderName?: string; senderEmail?: string; body?: string;
      messageDeliveryTime?: string; headers?: string;
    };
  };
}

/** 개별 메일 1통. 스레드 관계는 여러 통을 모아야 나오므로 buildThreads 가 따로 만든다. */
export async function extractEmail(file: string, sourceId: string): Promise<Extraction & { meta: MailMeta }> {
  const raw = await fs.readFile(file);
  const kind = path.extname(file).toLowerCase() === '.msg' ? 'msg' : 'eml';

  if (kind === 'msg') {
    // .msg 는 Outlook 독자 포맷이라 별도 파서를 쓴다.
    // CJS/ESM interop — 번들러에 따라 default 가 한 겹 더 감싸인다.
    const mod = (await import('@kenjiuno/msgreader')) as unknown as {
      default: MsgReaderCtor | { default: MsgReaderCtor };
    };
    const MsgReader = ('default' in mod.default ? mod.default.default : mod.default) as MsgReaderCtor;
    const msg = new MsgReader(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    const d = msg.getFileData();
    const headers = d.headers ?? '';
    const pick = (name: string) => headers.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? '';
    const meta: MailMeta = {
      sourceId,
      messageId: norm(pick('Message-ID')) || sourceId,
      inReplyTo: norm(pick('In-Reply-To')) || null,
      references: pick('References').split(/\s+/).map(norm).filter(Boolean),
      subject: d.subject ?? '',
      from: [d.senderName, d.senderEmail].filter(Boolean).join(' '),
      date: d.messageDeliveryTime ?? null,
    };
    const chunks: Chunk[] = [{
      anchor: { sourceId, locator: 'body', label: meta.subject || '본문' },
      text: [meta.subject, meta.from, d.body ?? ''].filter(Boolean).join('\n'),
    }];
    return { sourceId, filename: path.basename(file), kind, chunks, relations: [], warnings: [], meta };
  }

  const m = await simpleParser(raw);
  const refs = (Array.isArray(m.references) ? m.references : m.references ? [m.references] : []).map(norm);
  const meta: MailMeta = {
    sourceId,
    messageId: norm(m.messageId) || sourceId,
    inReplyTo: m.inReplyTo ? norm(m.inReplyTo) : null,
    references: refs,
    subject: m.subject ?? '',
    from: m.from?.text ?? '',
    date: m.date ? m.date.toISOString() : null,
  };
  const chunks: Chunk[] = [{
    anchor: { sourceId, locator: 'body', label: meta.subject || '본문' },
    text: [meta.subject, meta.from, (m.text ?? '').trim()].filter(Boolean).join('\n'),
  }];
  return { sourceId, filename: path.basename(file), kind, chunks, relations: [], warnings: [], meta };
}

/** 여러 통의 메일에서 스레드 관계를 만든다. 입력 순서와 무관하게 동작한다. */
export function buildThreads(metas: readonly MailMeta[]): Relation[] {
  const byMessageId = new Map(metas.map((m) => [m.messageId, m]));
  const relations: Relation[] = [];
  for (const m of metas) {
    const parentId = m.inReplyTo ?? m.references[m.references.length - 1] ?? null;
    if (!parentId) continue;
    const parent = byMessageId.get(parentId);
    if (!parent) continue; // 스레드 밖의 메일은 관계를 만들지 않는다
    relations.push({
      from: `${m.sourceId}#body`,
      to: `${parent.sourceId}#body`,
      kind: 'replies-to',
      confidence: 'EXTRACTED',
    });
  }
  return relations;
}
