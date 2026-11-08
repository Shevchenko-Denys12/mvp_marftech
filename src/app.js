// HTTP-шар: статичні файли, невеликий JSON API і журнал запусків.
// Без фреймворків: достатньо вбудованого node:http.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { compileRules } from './filters.js';
import { generateVariants, validateRequest, DEFAULT_COUNTS, MAX_PER_TYPE, SCRIPT_MIN, SCRIPT_MAX } from './harness.js';
import { HarnessError, ProviderError } from './errors.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const SAMPLES_DIR = path.join(ROOT, 'samples');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function sendApiError(res, e) {
  if (e instanceof HarnessError) {
    return sendJson(res, 400, { error: { code: e.code, message: e.message } });
  }
  if (e instanceof ProviderError) {
    const status = e.code === 'rate_limited' ? 429 : 502;
    return sendJson(res, status, { error: { code: e.code, message: e.message, retryAfterSec: e.retryAfterSec ?? null } });
  }
  console.error(e);
  return sendJson(res, 500, { error: { code: 'internal', message: 'Внутрішня помилка сервера' } });
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HarnessError('bad_request', 'Запит завеликий');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HarnessError('bad_request', 'Некоректний JSON у тілі запиту');
  }
}

async function loadSamples() {
  let files = [];
  try {
    files = (await fs.readdir(SAMPLES_DIR)).filter((f) => f.endsWith('.txt')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(SAMPLES_DIR, f), 'utf8');
    const [firstLine, ...rest] = raw.split(/\r?\n/);
    out.push({ id: f.replace(/\.txt$/, ''), title: firstLine.replace(/^#\s*/, '').trim(), script: rest.join('\n').trim() });
  }
  return out;
}

async function appendRunLog(file, entry) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Не вдалося записати журнал запусків:', e.message);
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: 'Не знайдено' } });
  }
  try {
    const data = await fs.readFile(full);
    const headers = {
      'content-type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff'
    };
    if (full.endsWith('.html')) headers['content-security-policy'] = "default-src 'self'";
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Не знайдено' } });
  }
}

export function createApp({ provider, brand, rules, runLogPath = null, restrictHost = true, maxBodyBytes = 64 * 1024 }) {
  const compiled = compileRules(rules);

  return http.createServer(async (req, res) => {
    try {
      // Сервер тримає API-ключ, тому на локальному запуску приймаємо лише запити з localhost
      // (захист від DNS rebinding: чужа сторінка не зможе спалити ваші ліміти).
      if (restrictHost && !LOOPBACK_HOST.test(req.headers.host ?? '')) {
        return sendJson(res, 403, { error: { code: 'forbidden_host', message: 'Недозволений Host' } });
      }

      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, {
          provider: provider.label,
          model: provider.models?.[0] ?? null,
          mock: provider.label === 'mock',
          limits: brand.limits,
          defaults: DEFAULT_COUNTS,
          maxPerType: MAX_PER_TYPE,
          scriptMin: SCRIPT_MIN,
          scriptMax: SCRIPT_MAX
        });
      }

      if (url.pathname === '/api/samples' && req.method === 'GET') {
        return sendJson(res, 200, await loadSamples());
      }

      if (url.pathname === '/api/generate') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Лише POST' } });
        const body = await readJsonBody(req, maxBodyBytes);
        const { script, counts } = validateRequest(body);
        const result = await generateVariants({ script, counts, provider, brand, rules: compiled });

        if (runLogPath) {
          await appendRunLog(runLogPath, {
            ts: new Date().toISOString(),
            provider: result.stats.provider,
            model: result.stats.model,
            counts,
            accepted: result.stats.accepted,
            rejected: result.stats.rejected,
            attempts: result.stats.attempts,
            ms: result.stats.ms,
            promptTokens: result.stats.promptTokens,
            completionTokens: result.stats.completionTokens,
            scriptChars: script.length,
            scriptHash: crypto.createHash('sha1').update(script).digest('hex').slice(0, 10)
          });
        }
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveStatic(res, url.pathname);
      }
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Не знайдено' } });
    } catch (e) {
      sendApiError(res, e);
    }
  });
}
