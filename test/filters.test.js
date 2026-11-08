import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrand, loadRules } from '../src/config.js';
import { checkCandidate, compileRules, jaccard, tokens, splitSentences, wordCount } from '../src/filters.js';

const brand = loadBrand();
const rules = compileRules(loadRules());

const ctx = (over = {}) => ({ limits: brand.limits, rules, accepted: [], originalSentences: [], ...over });
const check = (type, text, over) => checkCandidate({ type, text }, ctx(over));

test('валідний кандидат проходить і нормалізується', () => {
  const r = check('hook', '  "Where does the other sock go?"  ');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Where does the other sock go?');
});

test('порожній текст відхиляється', () => {
  assert.equal(check('hook', '   ').code, 'empty');
});

test('ліміт слів для хука', () => {
  const r = check('hook', 'one two three four five six seven eight nine ten eleven twelve thirteen');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_long');
});

test('ліміт символів для тексту на екрані', () => {
  const r = check('on_screen', 'Supercalifragilistic sockmagnet technology rocks');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_long');
});

test('заборонені формулювання: гарантія, знижка, відгуки', () => {
  assert.equal(check('hook', 'Guaranteed to stop sock loss').code, 'forbidden');
  assert.equal(check('hook', '50% off today only').code, 'forbidden');
  assert.equal(check('first_line', 'Read the reviews and see for yourself.').code, 'forbidden');
  assert.equal(check('hook', 'Hassle-free laundry starts here').ok, true);
});

test('вигадані числа: відсотки й чужі ціни', () => {
  assert.equal(check('first_line', 'It cuts sorting time by 40 percent, honestly 40%.').code, 'invented_number');
  assert.equal(check('first_line', 'Five pairs for $39 every quarter.').code, 'invented_number');
  assert.equal(check('first_line', 'Five pairs for $29 every quarter.').ok, true);
  // регресія: кома одразу після ціни не робить її «іншою» ціною
  assert.equal(check('first_line', 'Five pairs are $29, and a new set arrives every quarter.').ok, true);
  assert.equal(check('first_line', 'It costs $1,000 for five pairs.').code, 'invented_number');
});

test('емодзі та хештеги відхиляються', () => {
  assert.equal(check('hook', 'Socks that stay put 🧦').code, 'emoji');
  assert.equal(check('hook', 'Socks that stay put #socklock').code, 'hashtag');
});

test('майже дубль відхиляється, відмінний текст ні', () => {
  const accepted = [{ text: 'Stop losing socks in the wash' }];
  assert.equal(check('hook', 'Stop losing socks in the wash!', { accepted }).code, 'near_duplicate');
  assert.equal(check('hook', 'Where did that sock go?', { accepted }).ok, true);
});

test('копія речення з оригіналу відхиляється', () => {
  const script = 'The other one is gone. Again. Then I tried SockLock and everything changed for good.';
  const originalSentences = splitSentences(script);
  const r = check('first_line', 'Then I tried SockLock and everything changed for good.', { originalSentences });
  assert.equal(r.code, 'copies_original');
});

test('допоміжні функції', () => {
  assert.equal(wordCount('Wash. Dry. Still a pair.'), 5);
  assert.equal(jaccard(tokens('a b c'), tokens('a b d')), 0.5);
  assert.equal(jaccard([], tokens('a')), 0);
});
