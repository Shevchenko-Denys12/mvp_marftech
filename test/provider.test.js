import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatProvider, pickChatModels } from '../src/providers/openai-compat.js';
import { resolveProviderConfig } from '../src/config.js';

// Локальний фейковий OpenAI-сумісний сервер: перевіряємо реальні HTTP-запити без мережі й ключів.
async function startFake(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    handler({ n: requests.length, body, res });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const ok = (res, content = '{"hooks":[]}', model = 'm1') => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
};
const err = (res, status, code, message = 'x', headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { code, message } }));
};

const make = (baseUrl, extra = {}) =>
  new OpenAICompatProvider({ baseUrl, apiKey: 'k', models: ['m1', 'm2'], label: 'fake', sleep: async () => {}, ...extra });
const msgs = [{ role: 'user', content: 'hi' }];

test('успішний виклик: тіло запиту, заголовки й токени', async () => {
  const f = await startFake(({ res }) => ok(res));
  try {
    const r = await make(f.baseUrl).complete({ messages: msgs, temperature: 0.5, maxTokens: 100 });
    assert.equal(r.text, '{"hooks":[]}');
    assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 7 });
    const sent = f.requests[0];
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer k');
    assert.equal(sent.body.model, 'm1');
    assert.equal(sent.body.temperature, 0.5);
    assert.equal(sent.body.max_tokens, 100);
    assert.deepEqual(sent.body.response_format, { type: 'json_object' });
  } finally {
    f.server.close();
  }
});

test('429 з коротким Retry-After: чекає і повторює ту саму модель', async () => {
  const waits = [];
  const f = await startFake(({ n, res }) => (n === 1 ? err(res, 429, 'rate_limit_exceeded', 'slow', { 'retry-after': '2' }) : ok(res)));
  try {
    const r = await make(f.baseUrl, { sleep: async (ms) => waits.push(ms) }).complete({ messages: msgs });
    assert.equal(r.model, 'm1');
    assert.deepEqual(waits, [2000]);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].body.model, 'm1');
  } finally {
    f.server.close();
  }
});

test('429 з довгим Retry-After на основній моделі: перехід на запасну', async () => {
  const f = await startFake(({ body, res }) => (body.model === 'm1' ? err(res, 429, 'rate_limit_exceeded', 'daily', { 'retry-after': '3600' }) : ok(res, '{}', 'm2')));
  try {
    const r = await make(f.baseUrl).complete({ messages: msgs });
    assert.equal(r.model, 'm2');
    assert.deepEqual(f.requests.map((x) => x.body.model), ['m1', 'm2']);
  } finally {
    f.server.close();
  }
});

test('429 на всіх моделях: rate_limited з поясненням', async () => {
  const f = await startFake(({ res }) => err(res, 429, 'rate_limit_exceeded', 'daily', { 'retry-after': '3600' }));
  try {
    await assert.rejects(make(f.baseUrl).complete({ messages: msgs }), (e) => {
      assert.equal(e.code, 'rate_limited');
      assert.equal(e.retryAfterSec, 3600);
      assert.match(e.message, /добовий ліміт/);
      return true;
    });
  } finally {
    f.server.close();
  }
});

test('401: auth без повторів і без переходу на запасну модель', async () => {
  const f = await startFake(({ res }) => err(res, 401, 'invalid_api_key'));
  try {
    await assert.rejects(make(f.baseUrl).complete({ messages: msgs }), (e) => e.code === 'auth');
    assert.equal(f.requests.length, 1);
  } finally {
    f.server.close();
  }
});

test('model_not_found на основній моделі: запасна відповідає', async () => {
  const f = await startFake(({ body, res }) => (body.model === 'm1' ? err(res, 404, 'model_not_found', 'The model `m1` does not exist') : ok(res, '{}', 'm2')));
  try {
    const r = await make(f.baseUrl).complete({ messages: msgs });
    assert.equal(r.model, 'm2');
  } finally {
    f.server.close();
  }
});

test('500: повторює до maxRetries, потім upstream', async () => {
  const f = await startFake(({ res }) => err(res, 500, 'server_error', 'boom'));
  try {
    await assert.rejects(make(f.baseUrl, { maxRetries: 1 }).complete({ messages: msgs }), (e) => e.code === 'upstream');
    assert.equal(f.requests.length, 2);
  } finally {
    f.server.close();
  }
});

test('json_validate_failed: bad_response, щоб harness міг повторити', async () => {
  const f = await startFake(({ res }) => err(res, 400, 'json_validate_failed', 'bad json'));
  try {
    await assert.rejects(make(f.baseUrl).complete({ messages: msgs }), (e) => e.code === 'bad_response');
  } finally {
    f.server.close();
  }
});

test('недоступний сервер: network', async () => {
  const p = make('http://127.0.0.1:1/v1');
  await assert.rejects(p.complete({ messages: msgs }), (e) => e.code === 'network');
});

test('resolveProviderConfig: вибір провайдера зі змінних середовища', () => {
  assert.equal(resolveProviderConfig({}).kind, 'mock');
  assert.equal(resolveProviderConfig({ LLM_PROVIDER: 'mock', GROQ_API_KEY: 'x' }).kind, 'mock');

  const groq = resolveProviderConfig({ GROQ_API_KEY: 'gsk' });
  assert.equal(groq.label, 'groq');
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.deepEqual(groq.models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);

  const custom = resolveProviderConfig({ LLM_BASE_URL: 'http://x/v1', LLM_API_KEY: 'k', LLM_MODEL: 'a', LLM_FALLBACK_MODEL: 'b' });
  assert.deepEqual(custom.models, ['a', 'b']);

  assert.throws(() => resolveProviderConfig({ LLM_PROVIDER: 'groq' }), /GROQ_API_KEY/);
  assert.throws(() => resolveProviderConfig({ LLM_PROVIDER: 'nope' }), /Невідомий/);
});

test('усі задані моделі недоступні: бере найбільшу чат-модель зі списку /models', async () => {
  const f = await startFake(({ body, res, n }) => {
    if (body === null) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          data: [
            { id: 'whisper-large-v3', active: true },
            { id: 'openai/gpt-oss-20b', active: true },
            { id: 'openai/gpt-oss-120b', active: true },
            { id: 'meta-llama/llama-prompt-guard-2-22m', active: true }
          ]
        })
      );
    }
    return /gpt-oss/.test(body.model) ? ok(res, '{}', body.model) : err(res, 404, 'model_not_found', 'gone');
  });
  try {
    const p = make(f.baseUrl);
    const r = await p.complete({ messages: msgs });
    assert.equal(r.model, 'openai/gpt-oss-120b');
    assert.deepEqual(p.models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  } finally {
    f.server.close();
  }
});

test('усі моделі недоступні й /models порожній: віддає помилку model_not_found', async () => {
  const f = await startFake(({ body, res }) => {
    if (body === null) return err(res, 500, 'x');
    return err(res, 404, 'model_not_found', 'gone');
  });
  try {
    await assert.rejects(make(f.baseUrl).complete({ messages: msgs }), { code: 'model_not_found' });
  } finally {
    f.server.close();
  }
});

test('pickChatModels відкидає аудіо та модерацію й сортує за розміром', () => {
  const ids = pickChatModels([
    { id: 'whisper-large-v3' },
    { id: 'qwen/qwen3.8-27b' },
    { id: 'openai/gpt-oss-safeguard-20b' },
    { id: 'openai/gpt-oss-120b' },
    { id: 'old-model', active: false }
  ]);
  assert.deepEqual(ids, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
});

test('403 model_permission_blocked: модель вважається недоступною, а не помилкою ключа', async () => {
  const f = await startFake(({ body, res }) =>
    body.model === 'm1' ? err(res, 403, 'model_permission_blocked_org', 'blocked') : ok(res, '{}', 'm2')
  );
  try {
    const r = await make(f.baseUrl).complete({ messages: msgs });
    assert.equal(r.model, 'm2');
  } finally {
    f.server.close();
  }
});

test('справжній 403 без model_permission_blocked: помилка auth', async () => {
  const f = await startFake(({ res }) => err(res, 403, 'forbidden', 'nope'));
  try {
    await assert.rejects(make(f.baseUrl).complete({ messages: msgs }), { code: 'auth' });
  } finally {
    f.server.close();
  }
});
