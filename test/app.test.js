import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { loadBrand, loadRules } from '../src/config.js';
import { MockProvider } from '../src/providers/mock.js';
import { ProviderError } from '../src/errors.js';

const brand = loadBrand();
const rules = loadRules();
const SCRIPT =
  'Every laundry day I dig through the dryer and find one gray sock. The other one is gone. Then I tried SockLock and the pairs stayed together.';

async function withApp(provider, fn) {
  const app = createApp({ provider, brand, rules });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await fn(base, app.address().port);
  } finally {
    app.close();
  }
}

const post = (base, body) =>
  fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /api/config і /api/samples', async () => {
  await withApp(new MockProvider(), async (base) => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.mock, true);
    assert.equal(cfg.provider, 'mock');
    assert.equal(cfg.defaults.hook, 5);

    const samples = await (await fetch(`${base}/api/samples`)).json();
    assert.equal(samples.length, 3);
    assert.ok(samples[0].title.length > 0);
    assert.ok(samples[0].script.length > 100);
    assert.ok(!samples[0].script.startsWith('#'));
  });
});

test('POST /api/generate: повний цикл з mock-провайдером', async () => {
  await withApp(new MockProvider(), async (base) => {
    const resp = await post(base, { script: SCRIPT, counts: { hook: 3, first_line: 2, on_screen: 4 } });
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.variants.hook.length, 3);
    assert.equal(data.variants.first_line.length, 2);
    assert.equal(data.variants.on_screen.length, 4);
    assert.equal(data.stats.provider, 'mock');
    assert.ok(data.rejected.length >= 1);
  });
});

test('POST /api/generate: помилки валідації дають 400', async () => {
  await withApp(new MockProvider(), async (base) => {
    assert.equal((await post(base, { script: 'short' })).status, 400);
    const bad = await fetch(`${base}/api/generate`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/generate`)).status, 405);
  });
});

test('помилки провайдера: 429 для ліміту, 502 для решти', async () => {
  const limited = { label: 'fake', async complete() { throw new ProviderError('rate_limited', 'Ліміт', { retryAfterSec: 30 }); } };
  await withApp(limited, async (base) => {
    const resp = await post(base, { script: SCRIPT });
    assert.equal(resp.status, 429);
    const data = await resp.json();
    assert.equal(data.error.code, 'rate_limited');
    assert.equal(data.error.retryAfterSec, 30);
  });
  const broken = { label: 'fake', async complete() { throw new ProviderError('auth', 'Ключ'); } };
  await withApp(broken, async (base) => {
    assert.equal((await post(base, { script: SCRIPT })).status, 502);
  });
});

test('статичні файли: сторінка віддається, вихід за межі public заборонений', async () => {
  await withApp(new MockProvider(), async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>/);

    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope.txt`)).status, 404);
  });
});

test('чужий Host відхиляється (захист ключа від DNS rebinding)', async () => {
  await withApp(new MockProvider(), async (_base, port) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config', headers: { host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
