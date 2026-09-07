// 허브 토큰 보관. **토큰은 Vault 폴더에 절대 쓰지 않는다.**
//
// Vault 폴더는 통째로 복사되거나 백업되고, 사내에서는 그 복사본이 어디로 갈지 모른다.
// 그래서 토큰은 사용자 데이터 폴더에 OS 자격 증명 저장소로 암호화해서 둔다
// (Windows 는 DPAPI, macOS 는 Keychain).
//
// 이 파일은 Electron 을 import 하지 않는다 — 암호화 수단을 주입받는다. 그래야
// 테스트가 가짜 수단으로 파일 형식과 잠금 규칙을 검증할 수 있다.
import fs from 'node:fs/promises';
import path from 'node:path';

/** Electron `safeStorage` 의 필요한 만큼만. main.ts 가 실물을 넘긴다. */
export interface Cipher {
  /**
   * 이 시스템에서 **실제 암호화**가 되는가. Linux 에서 키링이 없으면 Electron 은
   * `basic_text` 로 떨어지는데 그건 난독화일 뿐이라 여기서는 불가로 본다.
   */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(enc: Buffer): string;
}

export interface TokenStore {
  available(): boolean;
  get(key: string): Promise<string | null>;
  set(key: string, token: string): Promise<void>;
  remove(key: string): Promise<void>;
}

interface CredFile {
  version: 1;
  /** 공간 id → base64 로 적은 암호문 */
  tokens: Record<string, string>;
}

/** 매번 새로 만든다. 상수를 얕게 복사하면 안쪽 `tokens` 를 공유해 값이 새어 나간다 */
const empty = (): CredFile => ({ version: 1, tokens: {} });

/**
 * 파일 하나에 공간 id 별로 토큰을 담는다. 값은 전부 암호문이고 평문은 어떤 경로로도
 * 디스크에 닿지 않는다 — 암호화가 안 되는 시스템이면 **저장을 거절한다.**
 */
export function credStore(file: string, cipher: Cipher): TokenStore {
  const read = async (): Promise<CredFile> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as CredFile;
      if (parsed.version !== 1 || typeof parsed.tokens !== 'object' || parsed.tokens === null) return empty();
      return parsed;
    } catch {
      // 없거나 깨졌으면 빈 것으로 본다. 토큰은 다시 입력받으면 되는 값이다.
      return empty();
    }
  };

  const write = async (data: CredFile): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  };

  return {
    available: () => cipher.available(),

    async get(key) {
      if (!cipher.available()) return null;
      const enc = (await read()).tokens[key];
      if (!enc) return null;
      try {
        return cipher.decrypt(Buffer.from(enc, 'base64'));
      } catch {
        // 다른 계정·다른 기기에서 만든 암호문이면 못 푼다. 다시 입력받는다.
        return null;
      }
    },

    async set(key, token) {
      if (!cipher.available()) throw new Error('이 시스템에서는 토큰을 안전하게 보관할 수 없습니다');
      const data = await read();
      data.tokens[key] = cipher.encrypt(token).toString('base64');
      await write(data);
    },

    async remove(key) {
      const data = await read();
      if (!(key in data.tokens)) return;
      delete data.tokens[key];
      await write(data);
    },
  };
}
