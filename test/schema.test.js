import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, validateOutput } from '../src/schema.js';

test('extractJson: чистий JSON, блок ```json і шум навколо', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":3} Hope it helps.'), { a: 3 });
});

test('extractJson: помилка на порожньому та не-JSON тексті', () => {
  assert.throws(() => extractJson(''));
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => extractJson('{"a": '));
});

test('validateOutput: об’єкти й рядки, аналіз, помилки елементів', () => {
  const v = validateOutput({
    analysis: { pain: 'lost socks', emotion: 'frustration', hook_type: 'story', angle: 'magnet', cta: 'tap' },
    hooks: [{ text: 'Hook one', angle: 'humor' }, 'Hook two', { angle: 'no text' }],
    first_lines: [{ text: 'First line', angle: 'story' }],
    on_screen_texts: 'not an array'
  });
  assert.equal(v.ok, true);
  assert.equal(v.items.length, 3);
  assert.deepEqual(v.items[1], { type: 'hook', text: 'Hook two', angle: '' });
  assert.equal(v.analysis.pain, 'lost socks');
  assert.equal(v.errors.length, 2);
});

test('validateOutput: відповідь без масивів не придатна', () => {
  assert.equal(validateOutput({ analysis: {} }).ok, false);
  assert.equal(validateOutput([]).ok, false);
  assert.equal(validateOutput(null).ok, false);
});
