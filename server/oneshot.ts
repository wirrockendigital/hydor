// One question to a model, outside any session: Claude (Haiku unless asked otherwise) when signed in,
// else Codex. No tools, settings, hooks or MCP servers, and nothing saved, so no session is left behind.
// Used for terminal command suggestions and pull-request descriptions and reading guides, and by the helper
// model on "Automatic" (an app's model steps, memory notes…). An account that has reached its usage limit, or
// is signed out, hands the question to the next one signed in, as sessions switch accounts at a limit.
import { execFile } from 'node:child_process';
import { execProgram } from './platform.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './auth.ts';
import { config } from './config.ts';
import { agentBaseEnv } from './env.ts';
import { backgroundDone, isSignedOut, markSignedIn, markSignedOut, signedOutText } from './signin.ts';

export interface OneShot {
  system: string;
  prompt: string;
  /** Claude model alias; Haiku by default. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** The Codex model when Claude cannot answer. */
  codexModel?: string;
  timeoutMs?: number;
  /** Stops the call (its program ends): an app's run stopped while its step asks. */
  signal?: AbortSignal;
  /**
   * Codex alone: do not read `$CODEX_HOME/config.toml` (its plugins, skills, MCP servers and hooks), and use this
   * `CODEX_HOME` for the call instead of the usual one. The sign-in still comes from the environment's own home, so an
   * added account is used as it is; a caller that wants a scratch home copies `auth.json` into it first.
   */
  ignoreUserConfig?: boolean;
  /**
   * Codex alone: the `CODEX_HOME` for the call. A home of its own keeps the call's SQLite files, caches and plugin
   * syncs out of the user's; it needs the sign-in to be reachable there (a copy of `auth.json`), and the sign-in
   * still comes from the caller's environment.
   */
  codexHome?: string;
  /** Claude Code alone: also skip hooks, plugins, skills and the CLAUDE.md discovery (`--bare`). */
  bare?: boolean;
}

type Env = Record<string, string>;

/** An account to ask: its id when it is an added one (none for the program's own sign-in), and the environment that points the CLI at it. */
export interface OneShotAccount {
  account?: string;
  env: Env;
}

/** The accounts to try for each program, the default one first (index.ts sets it). */
let accountsOf: (agent: 'claude' | 'codex') => OneShotAccount[] = () => [{ env: {} }];
export const setOneShotAccounts = (f: (agent: 'claude' | 'codex') => OneShotAccount[]) => (accountsOf = f);

/** An account of a program that was signed out when the question came. */
export interface SignedOutAccount {
  agent: 'claude' | 'codex';
  account?: string;
}

/**
 * Why an account gave no answer; `next`: another account may (a limit reached, signed out), unlike a call that ran out of
 * time. `signedOut`: its sign-in is what the program refused. `signedOutAccounts`: what a program's whole round found
 * signed out (those that said so, and those passed over because they had lately).
 */
class NoAnswer extends Error {
  constructor(
    message: string,
    readonly next = true,
    readonly signedOut = false,
    readonly signedOutAccounts: SignedOutAccount[] = [],
  ) {
    super(message);
  }
}

const asNoAnswer = (e: unknown) => (e instanceof NoAnswer ? e : new NoAnswer((e as Error)?.message || 'it did not answer'));

/** The last line a program wrote that says something (not the CLI's note that nothing came on stdin); an error as JSON, by its message. */
function lastLine(s: string): string {
  const line =
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^Warning: no stdin data/i.test(l))
      .pop() ?? '';
  // Codex: ERROR: {"type":"error","status":400,"error":{"message":"The '…' model is not supported…"}}
  const json = /^(?:ERROR:\s*)?(\{.*\})$/.exec(line)?.[1];
  if (json) {
    try {
      const j = JSON.parse(json);
      const msg = j?.error?.message ?? j?.message;
      if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
    } catch {}
  }
  return line.slice(0, 300);
}

/** Prompts longer than this (in bytes) go on stdin: one argument may hold at most 128 KiB on Linux. */
const ARG_MAX = 64 * 1024;
const long = (text: string) => Buffer.byteLength(text) > ARG_MAX;

/** Runs a CLI with `input` on stdin (else nothing): what it wrote, and why it failed when it did (in words, never the whole command). */
function run(bin: string, args: string[], o: { timeout: number; env?: Env; signal?: AbortSignal; input?: string }): Promise<{ ok: boolean; stdout: string; stderr: string; why?: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const child = execProgram(bin, args, { cwd: os.tmpdir(), env: { ...agentBaseEnv(), ...o.env }, timeout: o.timeout, maxBuffer: 8 * 1024 * 1024, signal: o.signal }, (err, stdout, stderr) => {
      const out = stdout;
      const errs = stderr;
      if (!err) return resolve({ ok: true, stdout: out, stderr: errs });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (o.signal?.aborted) return resolve({ ok: false, stdout: out, stderr: errs, why: 'it was stopped' });
      if (e.code === 'ENOENT') return resolve({ ok: false, stdout: out, stderr: errs, why: 'it is not installed' });
      if (e.killed) return resolve({ ok: false, stdout: out, stderr: errs, why: `it did not answer within ${Math.round(o.timeout / 1000)} s`, timedOut: true });
      resolve({ ok: false, stdout: out, stderr: errs, why: lastLine(errs) || 'it failed' });
    });
    // A long prompt comes on stdin; else nothing does: left open, Claude waits 3 s for it on every call and Codex waits until it is killed.
    child.stdin?.on('error', () => {});
    child.stdin?.end(o.input);
  });
}

/** Claude's answer from its JSON, or why there is none: its own words when it gave some ("You've hit your weekly limit · resets…"). */
function claudeAnswer(r: Awaited<ReturnType<typeof run>>): string {
  let j: { is_error?: boolean; result?: unknown; api_error_status?: unknown } | null = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  if (r.ok && j && !j.is_error && typeof j.result === 'string') return j.result;
  const said = j && typeof j.result === 'string' && j.result.trim() ? j.result.trim().slice(0, 300) : '';
  // "Not logged in · Please run /login", or a token the service rejected (401): the account is signed out, not at a limit.
  const out = !r.timedOut && (j?.api_error_status === 401 || signedOutText('claude', said || r.why || ''));
  throw new NoAnswer(said || r.why || 'it did not answer', !r.timedOut && r.why !== 'it was stopped', out);
}

/** The last few lines a program wrote (Codex's 401 is its last line, in stderr or stdout). */
const tail = (s: string, n = 3) => s.trim().split('\n').slice(-n).join('\n');

/**
 * Asks each account in turn, while the one before could not answer for a reason another may not have. An account found
 * signed out is marked (signin.ts) and passed over by the calls after, until the mark expires; one that answers clears
 * its mark (it was signed in again, in a terminal say).
 */
async function eachAccount(agent: 'claude' | 'codex', ask: (env: Env) => Promise<string>, signal?: AbortSignal): Promise<string> {
  const pool = accountsOf(agent);
  const out: SignedOutAccount[] = [];
  let first: NoAnswer | null = null;
  for (const { account, env } of pool.length ? pool : [{ env: {} }]) {
    if (isSignedOut(agent, account)) {
      out.push({ agent, account });
      continue;
    }
    try {
      const answer = await ask(env);
      markSignedIn(agent, account);
      backgroundDone();
      return answer;
    } catch (e) {
      const why = asNoAnswer(e);
      if (why.signedOut) {
        markSignedOut(agent, account, why.message);
        out.push({ agent, account });
        // Another account may do; the reason to give when none does is the sign-out, unless one said something else before.
        if (!signal?.aborted) continue;
      }
      first ??= why;
      if (!why.next || signal?.aborted) break;
    }
  }
  // Every account was signed out (said so, or passed over): that is the whole reason.
  const only = !first && out.length > 0;
  throw new NoAnswer(only ? (out.length === 1 ? 'signed out' : `all ${out.length} accounts are signed out`) : (first?.message ?? 'it did not answer'), first?.next ?? true, only, out);
}

const CLAUDE_FLAGS = ['--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json'];

/**
 * Claude Code's arguments for one question: no tools, no setting sources, no MCP servers, no session on disk and no
 * skills. `bare` goes further (plugins, hooks and CLAUDE.md discovery off too), which a suggestion uses: it is a
 * question to a program, not a session. Exported for the tests, which check the flags without starting Claude.
 */
export function claudeArgs(q: OneShot): { args: string[]; piped: boolean } {
  // --tools takes a list, so another flag must follow it; the prompt goes last, or on stdin when it is long.
  const piped = long(q.prompt);
  const args = ['-p', '--model', q.model ?? 'haiku', '--tools', '', ...(q.bare ? ['--bare'] : []), ...CLAUDE_FLAGS, '--system-prompt', q.system, ...(piped ? [] : [q.prompt])];
  return { args, piped };
}

export async function askClaude(q: OneShot): Promise<string> {
  const { args, piped } = claudeArgs(q);
  return eachAccount('claude', async (env) => claudeAnswer(await run(config.claudeBin, args, { timeout: q.timeoutMs ?? 90_000, env, signal: q.signal, input: piped ? q.prompt : undefined })), q.signal);
}

/**
 * Codex's arguments for one question: `--ephemeral` (nothing kept in the rollout), read-only, and — with
 * `ignoreUserConfig` — without the user's `config.toml`, so their plugins, skills, hooks and MCP servers stay out of a
 * suggestion's call. `codexHome` points the call at a home of its own, keeping its SQLite files and caches out of the
 * usual one. Exported for the tests, which check the flags without starting Codex.
 */
export function codexArgs(q: OneShot, file: string): { args: string[]; question: string; piped: boolean } {
  const question = `${q.system}\n\n${q.prompt}`;
  const piped = long(question);
  // With `ignoreUserConfig` the config's plugin, skill and hook features go too: --ignore-user-config alone keeps their
  // defaults, and a plugin cache in a fresh home shows that they still sync.
  const off = q.ignoreUserConfig ? ['-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'mcp_servers={}'] : [];
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', ...(q.ignoreUserConfig ? ['--ignore-user-config'] : []), ...off, ...(q.codexModel ? ['-m', q.codexModel] : []), '-c', 'model_reasoning_effort="low"', '-o', file, piped ? '-' : question];
  return { args, question, piped };
}

async function askCodex(q: OneShot): Promise<string> {
  return eachAccount(
    'codex',
    async (env) => {
      const file = path.join(os.tmpdir(), `wa-ask-${crypto.randomBytes(6).toString('hex')}.txt`);
      const timeout = Math.max(q.timeoutMs ?? 90_000, 90_000);
      try {
        const { args, question, piped } = codexArgs(q, file);
        const r = await run(config.codexBin, args, { timeout, env: q.codexHome ? { ...env, CODEX_HOME: q.codexHome } : env, signal: q.signal, input: piped ? question : undefined });
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (r.ok && text.trim()) return text;
        // "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header": the last line, in stderr or stdout.
        const out = !r.ok && !r.timedOut && signedOutText('codex', [r.why, tail(r.stderr), tail(r.stdout)].join('\n'));
        throw new NoAnswer(r.why ?? 'it gave no answer', !r.timedOut && r.why !== 'it was stopped', out);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    q.signal,
  );
}

/**
 * Claude alone (no Codex after it), reading the given files with its Read tool and nothing else: a picture to
 * describe. The files' folders are opened to it; the prompt names the files.
 */
export async function askClaudeAbout(q: OneShot & { files: string[] }): Promise<string> {
  const dirs = [...new Set(q.files.map((f) => path.dirname(f)))];
  const args = ['-p', '--model', q.model ?? 'haiku', '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', ...dirs, ...CLAUDE_FLAGS, '--system-prompt', q.system, q.prompt];
  try {
    return await eachAccount('claude', async (env) => claudeAnswer(await run(config.claudeBin, args, { timeout: q.timeoutMs ?? 120_000, env, signal: q.signal })), q.signal);
  } catch (e) {
    throw new Error(`Claude Code did not answer: ${asNoAnswer(e).message}`);
  }
}

/** No model answered (an HttpError 502); `signedOut` are the accounts of either program that were signed out, if that is why. */
export class NoModel extends HttpError {
  constructor(
    message: string,
    readonly signedOut: SignedOutAccount[] = [],
  ) {
    super(502, message);
  }
}

/** The signed-out accounts a failed call found, when the error says (none for any other error). */
export const signedOutOf = (e: unknown): SignedOutAccount[] => (e instanceof NoModel ? e.signedOut : []);

/** Who answered a one-off question: Claude Code or Codex. */
export type OneShotVia = 'claude' | 'codex';

/** The model's answer as text, and which of the two one-off programs wrote it (the pages must not credit the other). */
export async function oneShotAsked(q: OneShot): Promise<{ text: string; via: OneShotVia }> {
  let claude: NoAnswer;
  try {
    return { text: await askClaude(q), via: 'claude' };
  } catch (e) {
    claude = asNoAnswer(e);
  }
  if (q.signal?.aborted) throw new HttpError(409, 'It was stopped');
  try {
    return { text: await askCodex(q), via: 'codex' };
  } catch (e) {
    const codex = asNoAnswer(e);
    throw new NoModel(`Could not reach a model. Claude Code: ${claude.message.replace(/\.$/, '')}. Codex: ${codex.message.replace(/\.$/, '')}.`, [...claude.signedOutAccounts, ...codex.signedOutAccounts]);
  }
}

/** The model's answer as text. */
export async function oneShot(q: OneShot): Promise<string> {
  return (await oneShotAsked(q)).text;
}

/** The model's answer as JSON (the first object in it); `what` names it in the error. */
export async function oneShotJson<T>(q: OneShot, what: string): Promise<T> {
  const raw = await oneShot(q);
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as T;
  } catch {
    throw new HttpError(502, `The model did not answer with ${what}`);
  }
}
