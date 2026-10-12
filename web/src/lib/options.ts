import type { PermissionMode } from '@antlings/shared';

export const MODES: [PermissionMode, string][] = [
  ['default', 'Ask'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan'],
  ['bypassPermissions', 'Bypass'],
];

export const MODE_HINT: Record<PermissionMode, string> = {
  default: 'Asks before edits and commands.',
  acceptEdits: 'Edits files without asking. Other tools still ask.',
  plan: 'Explores and plans. No edits until you approve.',
  bypassPermissions: 'Runs every tool without asking. You confirm with a passkey or code first.',
};

export interface LastChoice {
  folder: string;
  model: string;
  effort: string;
  mode: PermissionMode;
}

const LAST_KEY = 'antlings:last-session';

/** The folder, model, effort and mode of the last session that was started, kept in this browser only. */
export function loadLast(): LastChoice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as Partial<LastChoice> | null;
    if (!raw || typeof raw.folder !== 'string' || typeof raw.model !== 'string') return null;
    const mode = MODES.some(([m]) => m === raw.mode) ? (raw.mode as PermissionMode) : 'default';
    return {
      folder: raw.folder,
      model: raw.model,
      effort: typeof raw.effort === 'string' ? raw.effort : '',
      mode,
    };
  } catch {
    return null;
  }
}

export function saveLast(c: LastChoice): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(c));
  } catch {
    /* private mode: the defaults simply are not remembered */
  }
}

/** "claude-haiku-4-5-20251001" becomes "Haiku 4.5". Unknown ids are returned as they are. */
export function prettyModel(raw: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(raw);
  return m ? `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : raw;
}

/** Folder paths are relative to the home folder of the service user. */
export const showPath = (rel: string): string => (rel === '' ? '~' : `~/${rel}`);
