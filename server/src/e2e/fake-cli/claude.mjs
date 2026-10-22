// Stand-in for the Claude Code CLI login commands. The code that signs in is `goodcode1`.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
const state = join(home, '.fake-claude-state');
const [group, action] = process.argv.slice(2);

if (group === 'auth' && action === 'login') {
  console.log('Opening browser to sign in…');
  console.log(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc",
  );
  process.stdout.write('Paste code here if prompted > ');
  const timer = existsSync(join(home, '.fake-hold')) ? setTimeout(() => process.exit(1), 30_000) : undefined;
  process.stdin.once('data', (d) => {
    clearTimeout(timer);
    if (String(d).trim() === 'goodcode1') {
      writeFileSync(state, 'in');
      process.exit(0);
    }
    process.exit(1);
  });
} else if (group === 'auth' && action === 'status') {
  if (existsSync(state) && readFileSync(state, 'utf8') === 'in') {
    console.log(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'max',
        email: 'me@example.com',
      }),
    );
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
  }
} else if (group === 'auth' && action === 'logout') {
  rmSync(state, { force: true });
} else {
  process.exit(2);
}
