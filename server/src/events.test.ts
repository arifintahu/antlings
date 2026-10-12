import { describe, expect, it } from 'vitest';
import { cleanUserText, historyEvents } from './events.js';

describe('cleanUserText', () => {
  it('turns a slash command into plain text', () => {
    const raw =
      '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>';
    expect(cleanUserText(raw)).toEqual({ text: '/exit', stdout: '' });
  });

  it('keeps command arguments', () => {
    const raw =
      '<command-name>/model</command-name><command-message>model</command-message><command-args>haiku</command-args>';
    expect(cleanUserText(raw).text).toBe('/model haiku');
  });

  it('separates local command output and drops caveats and reminders', () => {
    expect(cleanUserText('<local-command-stdout>See ya!</local-command-stdout>')).toEqual({
      text: '',
      stdout: 'See ya!',
    });
    expect(cleanUserText('<local-command-caveat>Caveat: ignore</local-command-caveat>')).toEqual({
      text: '',
      stdout: '',
    });
    expect(cleanUserText('Fix it <system-reminder>secret hint</system-reminder>').text).toBe('Fix it');
  });

  it('leaves ordinary text alone, including angle brackets that are not Claude Code tags', () => {
    expect(cleanUserText('use <div>x</div> here').text).toBe('use <div>x</div> here');
  });
});

describe('historyEvents', () => {
  it('shows terminal commands cleanly and output as a notice', () => {
    const ev = historyEvents([
      {
        type: 'user',
        message: {
          content:
            '<command-name>/exit</command-name><command-message>exit</command-message><command-args></command-args>',
        },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { content: '<local-command-stdout>See ya!</local-command-stdout>' },
        parent_tool_use_id: null,
      },
      { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null },
    ]);
    expect(ev).toEqual([
      { k: 'user', text: '/exit' },
      { k: 'notice', message: 'See ya!' },
      { k: 'user', text: 'hello' },
    ]);
  });
});
