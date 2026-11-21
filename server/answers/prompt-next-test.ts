// Regression tests for the next-message suggestion: it is opt-in, the server tracks consent,
// and a confidential session can use only the selected local helper model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, kvSet } from '../db.ts';
import { localHelper } from '../helper.ts';
import {
  clearSuggestions,
  confirmPromptRecipient,
  cutContext,
  dropSuggestion,
  keepSuggestion,
  promptFallback,
  promptNext,
  promptSuggestionsOn,
  promptSuggestionSettings,
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
// The models the app's helper picks from are read from the data folder, so a scratch folder of its own keeps the
// real ones out of the test (config.ts resolves that folder when the server starts).
fs.mkdirSync(path.join(process.env.DATA_DIR!, 'models'), { recursive: true });
fs.writeFileSync(path.join(process.env.DATA_DIR!, 'models', 'agent.json'), JSON.stringify({ models: [
  { id: 'local/model', label: 'Local model', provider: 'openrouter', baseUrl: '', model: 'local', local: true },
  { id: 'cloud/fallback', label: 'Cloud fallback', provider: 'openrouter', baseUrl: '', model: 'cloud' },
] }));

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('suggestions are off by default and activating alone never calls a model', async () => {
  assert.equal(promptSuggestionsOn(db), false);
  assert.equal(promptSuggestionSettings(db).on, false);
  let called = 0;
  setPromptNextForTests(async () => { called++; return { text: 'Nicht erlaubt', via: 'Test', model: 'auto' }; });
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null);
  assert.equal(called, 0, 'no model without consent');
  setPromptSuggestionsOn(db, true);
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null);
  assert.equal(called, 0, 'enabling alone is not consent');
  kvSet(db, 'prompt_suggestions_consent', JSON.stringify({ model: 'auto', at: Date.now() }));
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null, 'automatic cannot identify the recipient');
  kvSet(db, 'helper.model', 'local/model');
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  assert.equal((await promptNext(db, { context: 'User: Hallo', lang: 'German' }))?.text, 'Nicht erlaubt');
  assert.equal(called, 1, 'only a stored consent releases a helper call');
  setPromptNextForTests(null);
});

test('a changed helper model invalidates the previous consent', async () => {
  kvSet(db, 'prompt_suggestions_consent', '');
  let asked: (string | null | undefined)[] = [];
  setPromptNextForTests(async (_db, a) => {
    const used = a.local ? localHelper(db) : promptFallback(db);
    asked.push(used);
    return { text: `Antwort ${asked.length} von ${used ?? 'keinem Modell'}`, via: 'Local model', model: used ?? '' };
  });
  kvSet(db, 'helper.model', 'cloud/fallback');
  setPromptSuggestionsOn(db, true);
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null, 'enabling is not consent');
  assert.throws(() => confirmPromptRecipient(db, 'local/model', 'stale'));
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null, 'a changed recipient cannot reuse the consent');
  assert.deepEqual(asked, [], 'and a changed recipient means no call');
  kvSet(db, 'helper.model', 'local/model');
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  assert.equal((await promptNext(db, { context: 'User: Hallo', lang: 'German' }))?.text, 'Antwort 1 von local/model');
  assert.deepEqual(asked, ['local/model'], 'the agreed model is the one asked');
  setPromptNextForTests(null);
});

test('a confidential context uses only the local helper, even with a cloud fallback stored', async () => {
  kvSet(db, 'helper.model', 'local/model');
  setPromptSuggestionsOn(db, true);
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  let asked: (string | null | undefined)[] = [];
  setPromptNextForTests(async (_db, a) => {
    const used = a.local ? localHelper(db) : promptFallback(db);
    asked.push(used);
    return { text: 'Lokal geschrieben', via: 'Local model', model: used ?? '' };
  });
  assert.equal((await promptNext(db, { context: 'User: Vertraulich', lang: 'German', local: true }))?.text, 'Lokal geschrieben');
  assert.deepEqual(asked, ['local/model'], 'a confidential context is asked on the local helper alone');
  kvSet(db, 'helper.model', 'cloud/fallback');
  confirmPromptRecipient(db, 'cloud/fallback', promptSuggestionSettings(db).recipient.fingerprint);
  assert.equal(
    await promptNext(db, { context: 'User: Vertraulich', lang: 'German', local: true }),
    null,
    'a cloud fallback never receives a confidential conversation, even with consent for it',
  );
  assert.deepEqual(asked, ['local/model'], 'and no second call was made');
  setPromptNextForTests(null);
});

test('changing the endpoint with the same id revokes consent and refuses a stale confirmation', async () => {
  kvSet(db, 'helper.model', 'local/model');
  const before = promptSuggestionSettings(db).recipient.fingerprint;
  confirmPromptRecipient(db, 'local/model', before);
  const file = path.join(process.env.DATA_DIR!, 'models', 'agent.json');
  const saved = fs.readFileSync(file, 'utf8');
  try {
    const config = JSON.parse(saved);
    config.models[0].baseUrl = 'https://new.example/v1';
    fs.writeFileSync(file, JSON.stringify(config));
    assert.equal(promptSuggestionSettings(db).consent, false);
    assert.throws(() => confirmPromptRecipient(db, 'local/model', before));
    assert.equal(await promptNext(db, { context: 'User: secret', lang: 'German' }), null);
  } finally {
    fs.writeFileSync(file, saved);
  }
});

test('a delayed answer is discarded after disabling or aborting the request', async () => {
  kvSet(db, 'helper.model', 'local/model');
  setPromptSuggestionsOn(db, true);
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  let release!: () => void;
  setPromptNextForTests(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { text: 'Too late', via: 'Local model', model: 'local/model' };
  });
  const controller = new AbortController();
  const pending = promptNext(db, { context: 'User: Hallo', lang: 'German', signal: controller.signal });
  controller.abort();
  setPromptSuggestionsOn(db, false);
  release();
  assert.equal(await pending, null);
  setPromptNextForTests(null);
});

test('a delayed answer is discarded if the same model id changes endpoint', async () => {
  kvSet(db, 'helper.model', 'local/model');
  setPromptSuggestionsOn(db, true);
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  const file = path.join(process.env.DATA_DIR!, 'models', 'agent.json');
  const saved = fs.readFileSync(file, 'utf8');
  let release!: () => void;
  setPromptNextForTests(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { text: 'Too late', via: 'Local model', model: 'local/model' };
  });
  try {
    const pending = promptNext(db, { context: 'User: Hallo', lang: 'German' });
    // Change the recipient while the model is still answering.
    const config = JSON.parse(saved);
    config.models[0].baseUrl = 'https://new.example/v1';
    fs.writeFileSync(file, JSON.stringify(config));
    release();
    assert.equal(await pending, null);
  } finally {
    fs.writeFileSync(file, saved);
    setPromptNextForTests(null);
  }
});

test('the context is bounded, replies are filtered, and errors remain silent', async () => {
  const cut = cutContext(['old', 'x'.repeat(100), 'new'], 20);
  assert.ok(cut.includes('new'), 'the newest message survives the cut');
  assert.ok(!cut.includes('old'), 'the oldest is dropped');
  assert.equal(cutContext(['a', '', 'b']).split('\n\n').length, 2, 'an empty message adds no blank line');
  assert.equal(usable('SILENT'), '', 'the model declining is not a suggestion');
  assert.equal(usable('I cannot suggest that'), '');
  assert.equal(usable('```js\ncode\n```'), '');
  assert.equal(usable('Mach weiter'), 'Mach weiter');
  assert.equal(usable('"In quotes"'), 'In quotes');
  kvSet(db, 'helper.model', 'local/model');
  setPromptSuggestionsOn(db, true);
  confirmPromptRecipient(db, 'local/model', promptSuggestionSettings(db).recipient.fingerprint);
  let called = 0;
  setPromptNextForTests(async () => {
    called++;
    throw new Error('provider unavailable');
  });
  // A failing model is the box's problem, never the conversation's: nothing is asked of the user, nothing thrown.
  assert.equal(await promptNext(db, { context: 'User: Hallo', lang: 'German' }), null);
  assert.equal(called, 1, 'the model was tried once');
  setPromptNextForTests(null);
});

test('suggestions are consumed once and expired or dropped suggestions disappear', () => {
  clearSuggestions();
  keepSuggestion({ key: 'session:a', text: 'Alt', via: 'Local model', at: Date.now() - 11 * 60_000 });
  assert.equal(takeSuggestion('session:a'), null);
  keepSuggestion({ key: 'session:b', text: 'Mach weiter', via: 'Local model', at: Date.now() });
  assert.equal(takeSuggestion('session:b')?.text, 'Mach weiter');
  assert.equal(takeSuggestion('session:b'), null);
  keepSuggestion({ key: 'session:c', text: 'Weg', via: 'Local model', at: Date.now() });
  dropSuggestion('session:c');
  assert.equal(takeSuggestion('session:c'), null);
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