import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UiEvent } from '@antlings/shared';
import { NotFoundError } from './sessions.js';
import { makeKit, type Creds, type Kit } from './testkit.js';

let kit: Kit;
let creds: Creds;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const NEW = { cwd: '/home/u/proj', model: 'sonnet', mode: 'default' as const };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function setup() {
  kit = await makeKit();
  creds = await kit.signIn();
  const meta = await kit.mgr.create(NEW);
  return meta.id;
}

const userEvents = (id: string): UiEvent[] =>
  (
    kit.auth.db.prepare('SELECT data FROM event_log WHERE session_id = ? ORDER BY seq').all(id) as {
      data: string;
    }[]
  )
    .map((r) => JSON.parse(r.data) as UiEvent)
    .filter((e) => e.k === 'user');

describe('sending attachments', () => {
  it('stores metadata only, marks the upload sent and hands the image to the agent', async () => {
    const id = await setup();
    const up = kit.uploads.save(id, 'shot.png', PNG);
    await kit.mgr.send(id, 'describe this', [up.id]);
    expect(userEvents(id)).toEqual([
      {
        k: 'user',
        text: 'describe this',
        attachments: [{ id: up.id, name: 'shot.png', size: PNG.length, kind: 'image' }],
      },
    ]);
    const raw = kit.auth.db
      .prepare('SELECT data FROM event_log WHERE session_id = ?')
      .all(id)
      .map((r) => (r as { data: string }).data)
      .join('');
    expect(raw).not.toContain(PNG.toString('base64'));
    expect(kit.agents.last.calls).toContain('send:describe this');
    expect(kit.agents.last.calls).toContain('images:1');
    expect(kit.uploads.get(id, up.id)?.sent).toBe(true);
  });

  it('plain text sends are unchanged', async () => {
    const id = await setup();
    await kit.mgr.send(id, 'hello');
    expect(userEvents(id)).toEqual([{ k: 'user', text: 'hello' }]);
    expect(kit.agents.last.calls).toContain('send:hello');
  });

  it('refuses an unknown id or an id from another session, without logging a message', async () => {
    const id = await setup();
    const other = (await kit.mgr.create(NEW)).id;
    const foreign = kit.uploads.save(other, 'a.png', PNG);
    await expect(kit.mgr.send(id, 'x', ['nope'])).rejects.toThrow(NotFoundError);
    await expect(kit.mgr.send(id, 'x', [foreign.id])).rejects.toThrow(NotFoundError);
    expect(userEvents(id)).toEqual([]);
    expect(kit.uploads.get(other, foreign.id)?.sent).toBe(false);
  });

  it('starts the agent with the session upload directory', async () => {
    const id = await setup();
    await kit.mgr.send(id, 'hello');
    expect(kit.agents.last.opts.additionalDirs).toEqual([kit.uploads.dirFor(id)]);
  });

  it('works end to end over the websocket and rejects six ids', async () => {
    const id = await setup();
    const srv = await kit.listen();
    const s = await srv.open(creds);
    s.send({ t: 'hello', sessionId: id, lastSeq: 0 });
    const up = kit.uploads.save(id, 'shot.png', PNG);
    s.send({ t: 'send', sessionId: id, text: 'describe', attachmentIds: [up.id] });
    await s.waitFor(
      (m) =>
        m.t === 'event' &&
        (m.event as UiEvent).k === 'user' &&
        !!(m.event as { attachments?: unknown }).attachments,
    );
    await s.waitFor(
      (m) => m.t === 'event' && (m.event as { text?: string }).text === 'I got 1 image(s) and 0 file(s)',
    );
    s.send({ t: 'send', sessionId: id, text: 'x', attachmentIds: ['1', '2', '3', '4', '5', '6'] });
    expect((await s.waitFor((m) => m.t === 'error')).code).toBe('bad_message');
    expect(s.ws.readyState).toBe(s.ws.OPEN);
  });
});

describe('a send that cannot be completed', () => {
  it('tells the page the attachment expired, with its own error code', async () => {
    const id = await setup();
    const srv = await kit.listen();
    const s = await srv.open(creds);
    s.send({ t: 'hello', sessionId: id, lastSeq: 0 });
    s.send({ t: 'send', sessionId: id, text: 'long prompt', attachmentIds: ['gone'] });
    const err = await s.waitFor((m) => m.t === 'error');
    expect(err.code).toBe('attachment_expired');
    expect(userEvents(id)).toEqual([]);
  });

  it('leaves no half-sent turn when the file is gone before it is read', async () => {
    const id = await setup();
    const up = kit.uploads.save(id, 'shot.png', PNG);
    unlinkSync(up.path);
    await expect(kit.mgr.send(id, 'look', [up.id])).rejects.toThrow();
    const kinds = kit.mgr.eventsAfter(id, 0).map((e) => e.event.k);
    expect(kinds).not.toContain('user');
    expect(kinds).not.toContain('state');
    expect(kit.uploads.get(id, up.id)?.sent).toBe(false);
  });
});

describe('deleting a session', () => {
  it('removes its uploads', async () => {
    const id = await setup();
    const up = kit.uploads.save(id, 'shot.png', PNG);
    const dir = dirname(up.path);
    await kit.mgr.remove(id);
    expect(kit.uploads.get(id, up.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(dirname(dir)).includes(id)).toBe(false);
  });
});
