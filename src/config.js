import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Мінімальний читач .env, щоб не тягнути залежність. Не перезаписує вже задані змінні.
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function loadBrand(file = path.join(ROOT, 'config', 'brand.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadRules(file = path.join(ROOT, 'config', 'rules.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function resolveProviderConfig(env = process.env) {
  const forced = (env.LLM_PROVIDER || '').trim().toLowerCase();

  if (forced === 'mock') return { kind: 'mock' };

  if (forced === 'openai-compatible' || (!forced && env.LLM_BASE_URL && env.LLM_API_KEY)) {
    if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) {
      throw new Error('Для OpenAI-сумісного провайдера потрібні LLM_BASE_URL, LLM_API_KEY і LLM_MODEL');
    }
    return {
      kind: 'openai-compatible',
      label: env.LLM_LABEL || 'custom',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      models: [...new Set([env.LLM_MODEL, env.LLM_FALLBACK_MODEL].filter(Boolean))]
    };
  }

  if (forced === 'groq' || (!forced && env.GROQ_API_KEY)) {
    if (!env.GROQ_API_KEY) throw new Error('LLM_PROVIDER=groq, але GROQ_API_KEY не заданий');
    return {
      kind: 'openai-compatible',
      label: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      models: [
        ...new Set([env.GROQ_MODEL || 'openai/gpt-oss-120b', env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-20b'])
      ]
    };
  }

  if (forced) throw new Error(`Невідомий LLM_PROVIDER: ${forced}`);
  return { kind: 'mock' };
}
