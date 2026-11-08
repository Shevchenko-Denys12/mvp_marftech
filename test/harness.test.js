import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrand, loadRules } from '../src/config.js';
import { compileRules } from '../src/filters.js';
import { generateVariants, validateRequest } from '../src/harness.js';
import { MockProvider } from '../src/providers/mock.js';
import { ProviderError } from '../src/errors.js';

const brand = loadBrand();
const rules = compileRules(loadRules());
const SCRIPT =
  'Every laundry day I dig through the dryer and find one gray sock. The other one is gone. Then I tried SockLock and the pairs stayed together.';

// Підставний провайдер: віддає заздалегідь підготовлені відповіді по черзі й запам'ятовує запити.
function scripted(responses) {
  const calls = [];
  return {
    label: 'fake',
    models: ['fake-model'],
    calls,
    async complete(args) {
      calls.push(args);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake-model', usage: { promptTokens: 10, completionTokens: 5 } };
    }
  };
}

const run = (provider, counts, extra = {}) => generateVariants({ script: SCRIPT, counts, provider, brand, rules, ...extra });

test('успішний шлях: точна кількість, надлишок відкидається, є статистика', async () => {
  const provider = scripted([
    {
      analysis: { pain: 'lost socks', emotion: 'annoyed', hook_type: 'story', angle: 'magnet', cta: 'tap' },
      hooks: [
        { text: 'Where did that sock go?', angle: 'direct question' },
        { text: 'Lost socks are optional now.', angle: 'contrarian take' },
        { text: 'Meet the socks that stay together.', angle: 'benefit-first' }
      ],
      first_lines: [],
      on_screen_texts: [{ text: 'Pairs stay together', angle: 'benefit-first' }]
    }
  ]);
  const r = await run(provider, { hook: 2, first_line: 0, on_screen: 1 });

  assert.equal(r.variants.hook.length, 2);
  assert.equal(r.variants.first_line.length, 0);
  assert.equal(r.variants.on_screen.length, 1);
  assert.equal(r.variants.hook[0].id, 'hook-1');
  assert.equal(r.analysis.pain, 'lost socks');
  assert.equal(r.stats.attempts, 1);
  assert.equal(r.stats.requested, 3);
  assert.equal(r.stats.accepted, 3);
  assert.equal(r.stats.promptTokens, 10);
  assert.equal(r.warnings.length, 0);
  // просимо трохи більше, ніж потрібно, щоб був запас на відсів
  assert.ok(provider.calls[0].meta.need.hook > 2);
  assert.equal(provider.calls[0].meta.need.first_line, 0);
});

test('відхилені кандидати добираються другою спробою, а модель отримує зворотний зв’язок', async () => {
  const provider = scripted([
    { hooks: [{ text: 'Guaranteed to end sock loss', angle: 'x' }, { text: 'Where did that sock go?', angle: 'y' }] },
    { hooks: [{ text: 'Lost socks are optional now.', angle: 'z' }] }
  ]);
  const r = await run(provider, { hook: 2, first_line: 0, on_screen: 0 });

  assert.equal(r.variants.hook.length, 2);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].code, 'forbidden');
  assert.equal(r.stats.attempts, 2);

  const secondPrompt = provider.calls[1].messages[1].content;
  assert.match(secondPrompt, /was rejected/);
  assert.match(secondPrompt, /Where did that sock go\?/); // вже прийняте не повторювати
});

test('некоректний JSON: повтор, а не падіння', async () => {
  const provider = scripted(['Sorry, I cannot do that', { hooks: [{ text: 'Where did that sock go?', angle: 'q' }] }]);
  const r = await run(provider, { hook: 1, first_line: 0, on_screen: 0 });
  assert.equal(r.variants.hook.length, 1);
  assert.equal(r.stats.attempts, 2);
  assert.equal(r.warnings.length, 1);
});

test('bad_response від провайдера теж повторюється', async () => {
  const provider = scripted([
    new ProviderError('bad_response', 'json_validate_failed'),
    { hooks: [{ text: 'Where did that sock go?', angle: 'q' }] }
  ]);
  const r = await run(provider, { hook: 1, first_line: 0, on_screen: 0 });
  assert.equal(r.variants.hook.length, 1);
});

test('жодної придатної відповіді: помилка bad_response', async () => {
  const provider = scripted(['nope']);
  await assert.rejects(
    run(provider, { hook: 1, first_line: 0, on_screen: 0 }),
    (e) => e instanceof ProviderError && e.code === 'bad_response'
  );
  assert.equal(provider.calls.length, 3);
});

test('часткова відповідь: повертаємо що є, з попередженням, не більше 3 спроб', async () => {
  const provider = scripted([{ hooks: [{ text: 'Where did that sock go?', angle: 'q' }] }]);
  const r = await run(provider, { hook: 3, first_line: 0, on_screen: 0 });
  assert.equal(r.variants.hook.length, 1);
  assert.equal(provider.calls.length, 3);
  assert.ok(r.warnings.some((w) => /бракує/.test(w)));
  assert.ok(r.rejected.some((x) => x.code === 'near_duplicate'));
});

test('помилки провайдера (ліміт, ключ) не маскуються', async () => {
  const provider = scripted([new ProviderError('rate_limited', 'ліміт', { retryAfterSec: 30 })]);
  await assert.rejects(run(provider, { hook: 1, first_line: 0, on_screen: 0 }), (e) => e.code === 'rate_limited');
});

test('mock-провайдер: усі прийняті варіанти в межах лімітів, «погані» відхилені правилами', async () => {
  const r = await run(new MockProvider(), { hook: 5, first_line: 5, on_screen: 5 });
  assert.equal(r.stats.accepted, 15);
  assert.equal(r.variants.hook.every((v) => v.words <= brand.limits.hookMaxWords), true);
  assert.equal(r.variants.on_screen.every((v) => v.chars <= brand.limits.onScreenMaxChars), true);
  const codes = r.rejected.map((x) => x.code).sort();
  assert.deepEqual(codes, ['forbidden', 'forbidden', 'too_long']);
});

test('validateRequest: межі скрипта й кількостей', () => {
  assert.throws(() => validateRequest({ script: 'short' }), /занадто короткий/);
  assert.throws(() => validateRequest({ script: 'x'.repeat(6001) }), /занадто довгий/);
  assert.throws(() => validateRequest({ script: SCRIPT, counts: { hook: 11 } }), /від 0 до 10/);
  assert.throws(() => validateRequest({ script: SCRIPT, counts: { hook: 1.5 } }), /цілим числом/);
  assert.throws(() => validateRequest({ script: SCRIPT, counts: { hook: 0, first_line: 0, on_screen: 0 } }), /хоча б один/);
  assert.throws(() => validateRequest({ script: SCRIPT, counts: { hook: 10, first_line: 10, on_screen: 10 } }), /не більше/);
  const ok = validateRequest({ script: `  ${SCRIPT}  `, counts: { hook: '3' } });
  assert.equal(ok.script, SCRIPT);
  assert.deepEqual(ok.counts, { hook: 3, first_line: 5, on_screen: 5 });
});
