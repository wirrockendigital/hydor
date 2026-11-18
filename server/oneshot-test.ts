// Script tests for the one-off question's isolation (server/oneshot.ts): what Claude Code and Codex are called with,
// checked on the argument lists rather than by starting either program. A suggestion is a question to a program, not a
// session: no tools, no skills, no plugins, no hooks, no MCP servers, nothing on disk in the user's home. Build and run
// with a scratch data folder:
//   OUTDIR=dist/dev node scripts/build-server.mjs server/oneshot-test.ts
//   DATA_DIR=/tmp/hydor-test-oneshot node dist/dev/oneshot-test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeArgs, codexArgs, type OneShot } from './oneshot.ts';

if (!process.env.DATA_DIR?.startsWith('/tmp/')) {
  console.error('Run with DATA_DIR=/tmp/… so nothing touches real data.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydor-oneshot-test-'));
const file = path.join(tmp, 'answer.txt');
const ask: OneShot = { system: 'Antworte in einem Satz.', prompt: 'Sage ok' };

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('Claude Code is asked with no tools, no setting sources, no MCP servers and no session on disk', () => {
  const { args } = claudeArgs(ask);
  const flag = (name: string) => args.includes(name);
  assert.ok(flag('--tools'), 'the tools flag is there');
  assert.equal(args[args.indexOf('--tools') + 1], '', 'and it names none');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'the user’s settings are not read');
  assert.ok(flag('--strict-mcp-config'), 'no MCP server but the ones named (none)');
  assert.ok(flag('--no-session-persistence'), 'nothing is written to the session store');
  assert.ok(flag('--disable-slash-commands'), 'no skills or commands');
  assert.ok(!flag('--bare'), 'bare is off unless asked: it also skips plugins and hooks');
});

test('Claude Code’s bare flag adds the rest: plugins, hooks and CLAUDE.md discovery off', () => {
  const { args } = claudeArgs({ ...ask, bare: true });
  assert.ok(args.includes('--bare'), 'bare is passed through');
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'bare is not a permission bypass');
  // The prompt stays an argument for a short question, never a file.
  assert.equal(args[args.length - 1], ask.prompt, 'the question is the last argument');
});

test('Codex is asked read-only and ephemerally; with ignoreUserConfig its config.toml is not read', () => {
  const plain = codexArgs(ask, file).args;
  assert.ok(plain.includes('--ephemeral'), 'nothing is kept of the rollout');
  assert.ok(plain.includes('read-only'), 'the sandbox is read-only');
  assert.ok(plain.includes('--skip-git-repo-check'), 'no repository is needed');
  assert.ok(!plain.includes('--ignore-user-config'), 'the user’s config is read unless a caller asks otherwise');
  const cut = codexArgs({ ...ask, ignoreUserConfig: true, codexModel: 'gpt-6.1-terra' }, file).args;
  assert.ok(cut.includes('--ignore-user-config'), 'a suggestion’s call does not read the user’s config (its plugins, skills, hooks, MCP servers)');
  // --ignore-user-config alone keeps the features' defaults: a fresh home showed a plugin cache syncing. Switched off too.
  assert.ok(cut.includes('features.plugins=false'), 'its plugins are off, not merely uncatalogued');
  assert.ok(cut.includes('features.hooks=false'), 'and its hooks');
  assert.ok(cut.includes('mcp_servers={}'), 'and no MCP server, not even one from a managed layer');
  assert.equal(cut[cut.indexOf('-m') + 1], 'gpt-6.1-terra', 'the model is named when one is given');
});

test('the question goes on stdin when it is too long for one argument', () => {
  const big = 'x'.repeat(70 * 1024);
  const claude = claudeArgs({ ...ask, prompt: big });
  assert.equal(claude.piped, true, 'Claude gets a long prompt on stdin');
  assert.ok(!claude.args.includes(big), 'and not as an argument');
  const codex = codexArgs({ ...ask, prompt: big }, file);
  assert.equal(codex.piped, true, 'Codex too');
  assert.equal(codex.args[codex.args.length - 1], '-', 'Codex reads the question from stdin');
});

test('the system prompt is data to both, and the two never write into the user’s home', () => {
  const { args } = claudeArgs({ ...ask, system: 'Du bist ein Assistent.' });
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'Du bist ein Assistent.');
  const { args: c } = codexArgs(ask, file);
  assert.equal(c[c.length - 1], `${ask.system}\n\n${ask.prompt}`, 'Codex gets system and question as its prompt');
  assert.ok(!c.includes('--dangerously-bypass-hook-trust'), 'hooks are never trusted for a suggestion');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.error('FAIL', name, '\n   ', (e as Error).message);
  }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `${tests.length}/${tests.length} passed`);
process.exit(failed ? 1 : 0);