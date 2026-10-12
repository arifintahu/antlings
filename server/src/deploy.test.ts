import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeKit } from './testkit.js';

const file = (p: string) => readFileSync(new URL(`../../deploy/${p}`, import.meta.url), 'utf8');

describe('fail2ban filter', () => {
  const conf = file('fail2ban/filter.d/antlings.conf');
  const failregex = /^failregex\s*=\s*(.+)$/m.exec(conf)![1]!;
  // fail2ban's <HOST> becomes a captured address group
  const re = new RegExp(failregex.replace('<ADDR>', '(?<host>[0-9a-fA-F:.]+)'));

  it('matches the line the service really writes, with and without a journald prefix', async () => {
    const kit = await makeKit();
    await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      remoteAddress: '203.0.113.9',
      payload: { password: 'x' },
    });
    const line = kit.logs.find((l) => l.startsWith('antlings-auth-fail'))!;
    expect(re.exec(line)?.groups?.host).toBe('203.0.113.9');
    expect(re.exec(`Oct 12 11:00:00 vps node[1234]: ${line}`)?.groups?.host).toBe('203.0.113.9');
    await kit.app.close();
  });

  it('matches an IPv6 address and does not match other lines', () => {
    expect(re.exec('antlings-auth-fail ip=2001:db8::1 reason=stepup-totp')?.groups?.host).toBe('2001:db8::1');
    for (const l of [
      'antlings-auth-lockout ip=203.0.113.9 scope=address',
      'antlings listening on 127.0.0.1:3100',
      'antlings-error something broke',
      'GET /antlings-auth-fail ip=1.2.3.4',
    ]) {
      expect(re.test(l), l).toBe(false);
    }
  });
});

describe('systemd unit', () => {
  const unit = file('antlings.service');
  it.each([
    'User=antlings',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'ReadWritePaths=/var/lib/antlings /home/antlings',
    'PrivateTmp=yes',
    'MemoryHigh=800M',
    'MemoryMax=1100M',
    'ProtectProc=invisible',
    'RestrictSUIDSGID=yes',
    'Restart=on-failure',
    'EnvironmentFile=/etc/antlings/antlings.env',
  ])('has %s', (line) => {
    expect(unit).toContain(line);
  });

  it('does not run as root, does not grant capabilities and keeps no secret in the file', () => {
    expect(unit).not.toMatch(/^User=root/m);
    expect(unit).not.toMatch(/AmbientCapabilities|CapabilityBoundingSet=.*CAP_/);
    expect(unit).not.toMatch(/(SECRET|PASSWORD)\w*=\S|API_KEY=\S/);
  });
});

describe('caddy snippet', () => {
  const snippet = file('Caddyfile.snippet');
  it('proxies to the loopback port and sets security headers', () => {
    expect(snippet).toContain('reverse_proxy 127.0.0.1:3100');
    expect(snippet).toContain('Strict-Transport-Security');
    expect(snippet).toContain('X-Content-Type-Options');
    expect(snippet).toContain('__DOMAIN__ {');
  });
  it('limits the sign-in path rate behind a marker that install.sh enables only when the module exists', () => {
    expect(snippet).toMatch(/#RL rate_limit @auth/);
    expect(snippet).toContain('/api/auth/*');
  });
});

describe('install scripts', () => {
  const install = file('install.sh');
  const uninstall = file('uninstall.sh');
  it('refuses to run with too little memory and supports a dry run', () => {
    expect(install).toContain('MIN_FREE_MB=600');
    expect(install).toContain('--dry-run');
  });
  it('never touches the services and settings it must leave alone', () => {
    for (const script of [install, uninstall]) {
      // comments may name them; commands must not
      const code = script
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/\bufw\b|postgres|redis|sudoers|visudo|iptables|nft\b/i);
      expect(code).not.toMatch(/>\s*\/etc\/caddy\/Caddyfile|sed -i[^\n]*Caddyfile\b(?!\.snippet)/);
    }
  });
  it('validates the Caddy config before reloading', () => {
    expect(install.indexOf('caddy validate')).toBeGreaterThan(-1);
    expect(install.indexOf('caddy validate')).toBeLessThan(install.indexOf('systemctl reload caddy'));
  });
  it('writes the env file with a restrictive mode and never prints secrets', () => {
    expect(install).toContain('umask 077');
    expect(install).toContain('chmod 640');
    expect(install).not.toMatch(/echo[^\n]*SECRET_KEY=\$/);
  });
});
