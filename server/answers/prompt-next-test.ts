// Script tests for the suggestion of the user's next message (server/answers/prompt-next.ts): the settings' keys and
// fallbacks, the cut of a long conversation, what counts as a usable answer, and the whole call with a stand-in model
// (a confidential session gets none, and nothing is kept). Build and run with a scratch data folder:
//   OUTDIR=dist/dev node scripts/build-server.mjs server/answers/prompt-next-test.ts
//   DATA_DIR=/tmp/hydor-test-prompt-next node dist/dev/prompt-next-test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, kvSet } from '../db.ts';
import { AGENT_FILE } from '../models/config.ts';
import {
  clearSuggestions,
  cutContext,
  dropSuggestion,
  keepSuggestion,
  promptFallback,
  promptNext,
  promptSuggestionsOn,
  promptSuggestionSettings,
  setPromptFallback,
  setPromptNextForTests,
  setPromptSuggestionsOn,
  takeSuggestion,
  usable,
} from './prompt-next.ts';

if (!process.env.DATA_DIR?.startsWith('/tmp/')) {
  console.error('Run with DATA_DIR=/tmp/… so nothing touches real data.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydor-prompt-next-'));
const db = openDb(path.join(tmp, 'test.db'));

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('the settings: on by default, off when set, and the fallback is the helper model until one is picked', () => {
  assert.equal(promptSuggestionsOn(db), true, 'on until someone turns it off');
  setPromptSuggestionsOn(db, false);
  assert.equal(promptSuggestionsOn(db), false);
  assert.equal(promptSuggestionSettings(db).on, false, 'the page sees it off');
  setPromptSuggestionsOn(db, true);
  assert.equal(promptSuggestionsOn(db), true);
  assert.equal(promptFallback(db), 'auto');
  assert.throws(() => setPromptFallback(db, 'openrouter/someone-else'), /No such model/, 'another maker’s model is not one of Custom’s');
  assert.equal(promptFallback(db), 'auto', 'a refused model changes nothing');
});

test('the cut keeps the newest messages: a long conversation loses its start, not its end', () => {
  const messages = ['oldest ' + 'x'.repeat(200), 'a middle one', 'the newest ' + 'y'.repeat(200)];
  const cut = cutContext(messages, 300);
  assert.ok(cut.includes('the newest'), 'the newest message is there');
  assert.ok(!cut.includes('oldest'), 'the oldest is dropped');
  assert.ok(cut.length <= 300 + 40, 'about as long as asked');
  assert.equal(cutContext([]), '');
});

test('only a short, plain sentence is usable: a refusal, the rules or a speech is not a suggestion', () => {
  assert.equal(usable('Kannst du das bitte prüfen?'), 'Kannst du das bitte prüfen?');
  assert.equal(usable('"Wie machen wir weiter?"'), 'Wie machen wir weiter?');
  assert.equal(usable('Next message: Sag mir mehr'), 'Sag mir mehr');
  assert.equal(usable('SILENT'), '');
  assert.equal(usable('I cannot suggest a next message here.'), '');
  assert.equal(usable('  '), '');
  assert.equal(usable('').valueOf(), '');
  assert.equal(usable('Eins\nZwei'), 'Eins', 'only the first line counts');
});

test('what is kept is kept for one session only, and only for a while', () => {
  clearSuggestions();
  // An old suggestion is dropped when it is looked at, and a kept one outlives a call: only the age matters.
  keepSuggestion({ key: 'acp:old', text: 'Alt', via: 'Custom', at: Date.now() - 11 * 60_000 });
  assert.equal(takeSuggestion('acp:old'), null, 'an old one is not offered');
  keepSuggestion({ key: 'acp:a', text: 'Mach weiter', via: 'Custom', at: Date.now() });
  const s = takeSuggestion('acp:a');
  assert.equal(s?.text, 'Mach weiter');
  assert.equal(takeSuggestion('acp:a'), null, 'taken once, then gone');
  keepSuggestion({ key: 'acp:c', text: 'Weg', via: 'Custom', at: Date.now() });
  dropSuggestion('acp:c');
  assert.equal(takeSuggestion('acp:c'), null);
});

test('the whole call: the session’s own model first, the fallback when it has none, and nothing when neither answers', async () => {
  // A stand-in in place of any model: no program, no API, no key.
  const asked: { model?: string | null; lang: string; context: string }[] = [];
  setPromptNextForTests(async (_db, a) => {
    asked.push({ model: a.model, lang: a.lang, context: a.context });
    // One sentence when the model is the session's own, none when only the fallback is left.
    if (a.model === 'openrouter/own:free') return { text: 'Kannst du das prüfen?', via: 'Eigenes Modell' };
    return null;
  });
  const own = await promptNext(db, { context: 'User: Hallo', lang: 'German', model: 'openrouter/own:free' });
  assert.equal(own?.text, 'Kannst du das prüfen?');
  assert.equal(own?.via, 'Eigenes Modell', 'the page is told which model wrote it');
  assert.equal(asked[0]?.lang, 'German', 'the app’s language reaches the model');
  const none = await promptNext(db, { context: 'User: Hallo', lang: 'German' });
  assert.equal(none, null, 'a model with nothing to suggest leaves the box empty');
  // A model that throws is the same as one with nothing: the session never sees an error.
  setPromptNextForTests(async () => {
    throw new Error('no model here');
  });
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null);
  setPromptNextForTests(null);
});

test('a confidential session is asked only on a model on this computer, and never on a fallback elsewhere', async () => {
  // No local helper is picked in this scratch folder: its words stay where they are, so nothing is asked.
  setPromptNextForTests(async () => ({ text: 'Nicht gefragt', via: 'Nicht gefragt' }));
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German', local: true }), null, 'no local helper: no suggestion');
  // A local model is named for the call, never the helper model's own choice.
  const asked: (string | null | undefined)[] = [];
  setPromptNextForTests(async (_db, a) => {
    asked.push(a.model);
    return { text: 'Lokal geschrieben', via: 'Lokales Modell' };
  });
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German', model: 'openrouter/elsewhere:free', local: true }), null, 'still none without a local helper');
  setPromptNextForTests(null);
});

test('a session that is not on (suggestions off) gets nothing, whatever the model says', async () => {
  setPromptNextForTests(async () => ({ text: 'Egal was', via: 'Egal' }));
  setPromptSuggestionsOn(db, false);
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null, 'off beats any model');
  setPromptSuggestionsOn(db, true);
  assert.equal((await promptNext(db, { context: 'User: Hallo', lang: 'German' }))?.text, 'Egal was');
  setPromptNextForTests(null);
});


test('a model that thinks first still has room for the sentence: the answer is asked with 800 tokens, not 120', async () => {
  // The bug this guards: at 120 tokens a reasoning model spent them all thinking and the sentence came back empty.
  // The test runs from dist/dev: the source is beside this file's own path in the checkout.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'server', 'answers', 'prompt-next.ts'), 'utf8');
  const m = /const MAX_TOKENS = (\d+);/.exec(src);
  assert.ok(m, 'the token limit is set');
  assert.ok(Number(m[1]) >= 400, `room to think and to answer (${m[1]} tokens)`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('ok  ', name);
  } catch (e) {
    failed++;
    console.error('FAIL', name, '\n   ', (e as Error).message);
  }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `${tests.length}/${tests.length} passed`);
process.exit(failed ? 1 : 0);