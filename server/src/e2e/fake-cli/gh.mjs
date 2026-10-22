// Stand-in for the GitHub CLI in tests and browser tests. State lives in $HOME so every test gets its own.
// $HOME/.fake-hold makes `auth login` wait 30 s so a test can cancel it.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const state = join(home, '.fake-gh-state');
const [group, action] = process.argv.slice(2);

if (group === 'auth' && action === 'login') {
  console.log('! First copy your one-time code: ABCD-1234');
  console.log('Open this URL to continue in your web browser: https://github.com/login/device');
  // $HOME/.fake-delay (milliseconds) slows the sign-in for browser tests; the default suits fast API tests.
  const delayFile = join(home, '.fake-delay');
  const wait = existsSync(join(home, '.fake-hold'))
    ? 30_000
    : existsSync(delayFile)
      ? Number(readFileSync(delayFile, 'utf8'))
      : 400;
  setTimeout(() => {
    writeFileSync(state, 'in');
    process.exit(0);
  }, wait);
} else if (group === 'auth' && action === 'status') {
  appendFileSync(join(home, '.fake-gh-status-calls'), 'x\n');
  if (existsSync(state) && readFileSync(state, 'utf8') === 'in') {
    console.log('github.com');
    console.log('  ✓ Logged in to github.com account octo (keyring)');
  } else {
    console.log('You are not logged into any GitHub hosts.');
    process.exit(1);
  }
} else if (group === 'auth' && action === 'logout') {
  rmSync(state, { force: true });
} else if (group === 'auth' && action === 'setup-git') {
  writeFileSync(join(home, '.fake-gh-setup-git'), '1');
} else {
  process.exit(2);
}
