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

/** Folder paths are relative to the home folder of the service user. */
export const showPath = (rel: string): string => (rel === '' ? '~' : `~/${rel}`);
