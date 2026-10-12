// Antlings SDK spike (2026-10-12). Run on the VPS inside a temp folder:
//   mkdir /tmp/cc-spike && cd /tmp/cc-spike && npm init -y && npm i @anthropic-ai/claude-agent-sdk --omit=optional
//   node spike.mjs        (uses /usr/bin/claude and the VPS login; costs a few cents of plan usage)
// Delete /tmp/cc-spike and ~/.claude/projects/-tmp-cc-spike-cwd afterwards.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'node:child_process';

const T0 = Date.now();
const log = (tag, o) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${tag} ${typeof o === 'string' ? o : JSON.stringify(o)}`);
const rssMb = () => {
  try { return execSync("ps -eo rss,args | grep -E '(claude|claude-agent-sdk|spike.mjs)' | grep -v grep | awk '{s+=$1} END {print int(s/1024)}'").toString().trim(); }
  catch { return '?'; }
};
setTimeout(() => { log('TIMEOUT', 'giving up'); process.exit(2); }, 150000);

// ── streaming input channel ──
const inbox = []; let wake = null;
async function* gen() {
  for (;;) {
    while (!inbox.length) await new Promise((r) => (wake = r));
    const m = inbox.shift(); if (m === null) return; yield m;
  }
}
const send = (text) => { inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); wake?.(); };

let turnDone = null; const seen = {}; let sessionId = null;
const waitTurn = () => new Promise((r) => (turnDone = r));

const q = query({
  prompt: gen(),
  options: {
    cwd: '/tmp/cc-spike-cwd', model: 'haiku', effort: 'low', permissionMode: 'default',
    settingSources: [], persistSession: false, includePartialMessages: false,
    pathToClaudeCodeExecutable: '/usr/bin/claude', allowedTools: ['Agent'],
    canUseTool: async (name, input) => { log('canUseTool', { name }); return { behavior: 'allow', updatedInput: input }; },
  },
});

(async () => {
  try {
    for await (const m of q) {
      const k = m.type + (m.subtype ? ':' + m.subtype : ''); seen[k] = (seen[k] || 0) + 1;
      if (m.type === 'system' && m.subtype === 'init') { sessionId = m.session_id; log('init', { model: m.model, cwd: m.cwd, permissionMode: m.permissionMode, tools: m.tools?.length, keys: Object.keys(m).join(',') }); }
      else if (m.type === 'system' && /^task_/.test(m.subtype)) log(m.subtype, { task_id: m.task_id, task_type: m.task_type, description: m.description, status: m.status ?? m.patch?.status, subagent_type: m.subagent_type, last_tool_name: m.last_tool_name, usage: m.usage, parent_task_id: m.parent_task_id, is_backgrounded: m.is_backgrounded });
      else if (m.type === 'rate_limit_event') log('rate_limit_event', m.rate_limit_info);
      else if ((m.type === 'assistant' || m.type === 'user') && m.parent_tool_use_id) { if (!seen._sub) { seen._sub = 1; log('subagent-msg', { type: m.type, parent_tool_use_id: !!m.parent_tool_use_id, agent_id: m.agent_id, keys: Object.keys(m).join(',') }); } }
      else if (m.type === 'assistant') { const t = m.message?.content?.filter((b) => b.type === 'tool_use').map((b) => b.name + ':' + JSON.stringify(b.input).slice(0, 80)); if (t?.length) log('assistant tool_use', t); }
      else if (m.type === 'result') {
        log('result', { subtype: m.subtype, text: (m.result || '').slice(0, 80), total_cost_usd: m.total_cost_usd, usage_in: m.usage?.input_tokens, usage_out: m.usage?.output_tokens, modelUsage: Object.keys(m.modelUsage || {}), session_id: m.session_id });
        turnDone?.();
      }
    }
  } catch (e) { log('stream error', String(e).slice(0, 300)); turnDone?.(); }
})();

try {
  log('rss start MB', rssMb());
  // turn 1: plain
  send('Reply with exactly: ok'); await waitTurn(); log('rss after turn1 MB', rssMb());

  const models = await q.supportedModels(); log('supportedModels', models.map((m) => ({ value: m.value, displayName: m.displayName })).slice(0, 8)); log('ModelInfo keys', Object.keys(models[0] || {}).join(','));
  const ctx = await q.getContextUsage({ detail: 'summary' });
  log('context', { model: ctx.model, total_tokens: ctx.total_tokens, raw_max_tokens: ctx.raw_max_tokens, percentage: ctx.percentage, categories: ctx.categories?.map((c) => `${c.name}:${c.tokens}:${c.kind}`) });
  const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  log('usage', { subscription_type: u.subscription_type, rate_limits_available: u.rate_limits_available, five_hour: u.rate_limits?.five_hour, seven_day: u.rate_limits?.seven_day, keys: Object.keys(u.rate_limits || {}).join(','), session_cost: u.session?.total_cost_usd });
  const acc = await q.accountInfo(); log('accountInfo keys', Object.keys(acc).join(','));

  // turn 2: subagent
  send('Use the Agent tool with subagent_type general-purpose and the prompt "Reply with exactly: ok". Then tell me what the subagent replied.'); await waitTurn(); log('rss after subagent turn MB', rssMb());

  // turn 3: switch model / mode / effort mid-session
  await q.setPermissionMode('plan'); await q.setModel('sonnet'); await q.applyFlagSettings({ effortLevel: 'medium' });
  log('switched', 'plan + sonnet + effort medium');
  send('Reply with exactly: ok'); await waitTurn(); log('rss after switch turn MB', rssMb());
  const ctx2 = await q.getContextUsage({ detail: 'summary' }); log('context after', { model: ctx2.model, total_tokens: ctx2.total_tokens, percentage: ctx2.percentage });
} catch (e) { log('ERROR', String(e.stack || e).slice(0, 500)); }
log('message types seen', seen);
inbox.push(null); wake?.(); q.close(); log('node rss MB', Math.round(process.memoryUsage().rss / 1048576));
setTimeout(() => process.exit(0), 500);
