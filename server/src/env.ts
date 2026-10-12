import { existsSync } from 'node:fs';

/** Loads the env file when the variables are not already set (CLI use, `sudo -u antlings antlings setup`). */
export function loadEnvFileIfNeeded(): void {
  if (process.env.ANTLINGS_SECRET_KEY) return;
  const file = process.env.ANTLINGS_ENV_FILE ?? '/etc/antlings/antlings.env';
  if (existsSync(file)) process.loadEnvFile(file);
}
