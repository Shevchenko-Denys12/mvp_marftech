import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../public/csv.js';

test('CSV: BOM, екранування лапок, ком і переносів', () => {
  const csv = toCsv([{ id: 'hook-1', text: 'Say "hi", then\nleave' }], ['id', 'text']);
  assert.equal(csv, '﻿id,text\r\nhook-1,"Say ""hi"", then\nleave"\r\n');
});

test('CSV: захист від формул', () => {
  const csv = toCsv([{ text: '=SUM(A1:A2)' }, { text: '+1' }, { text: 'ok' }], ['text']);
  assert.match(csv, /'=SUM\(A1:A2\)/);
  assert.match(csv, /'\+1/);
  assert.match(csv, /\r\nok\r\n/);
});
