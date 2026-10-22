import type { Auth } from '../auth/service.js';
import { decrypt, encrypt } from '../util.js';

export type ClaudeMode = 'apikey' | 'subscription';

const KEY_SETTING = 'anthropic_key';

/** Claude sign-in choices the owner makes in the UI. They are kept in the `settings` table and win over the env file. */
export class ConnectionSettings {
  constructor(private readonly auth: Auth) {}

  mode(): ClaudeMode {
    const m = this.auth.getSetting('claude_mode');
    return m === 'apikey' || m === 'subscription' ? m : this.auth.config.authMode;
  }
  setMode(m: ClaudeMode): void {
    this.auth.setSetting('claude_mode', m);
  }

  ackAt(): number | undefined {
    const v = this.auth.getSetting('subscription_ack_at');
    return v ? Number(v) : undefined;
  }
  setAck(at: number): void {
    this.auth.setSetting('subscription_ack_at', String(at));
  }

  hasApiKey(): boolean {
    return this.apiKey() !== undefined;
  }
  /** The stored key, or undefined when none is stored or it cannot be decrypted (for example after a key rotation). */
  apiKey(): string | undefined {
    const blob = this.auth.getSetting(KEY_SETTING);
    if (!blob) return undefined;
    try {
      return decrypt(this.auth.config.secretKey, blob);
    } catch {
      return undefined;
    }
  }
  setApiKey(key: string): void {
    this.auth.setSetting(KEY_SETTING, encrypt(this.auth.config.secretKey, key));
  }
  clearApiKey(): void {
    this.auth.setSetting(KEY_SETTING, '');
  }
}
