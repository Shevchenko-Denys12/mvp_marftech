// Клієнт для будь-якого OpenAI-сумісного /chat/completions (Groq, OpenRouter, ...).
// Без залежностей: глобальний fetch з Node 18+.
//
// Що вміє: JSON-режим, таймаут, повтори на 429/5xx з урахуванням Retry-After,
// перехід на запасну модель, якщо основна впирається в ліміт або недоступна
// (у Groq ліміти рахуються окремо для кожної моделі). Якщо недоступні всі задані
// моделі, запитує GET /models і бере найпотужнішу доступну чат-модель.

import { ProviderError } from '../errors.js';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// Моделі, які не вміють відповідати в /chat/completions (аудіо, модерація, ембедінги).
const NON_CHAT = /whisper|orpheus|tts|guard|safeguard|embed|moderation|transcri|rerank|allam/i;

// Розмір моделі з назви («120b» → 120), щоб віддати перевагу більшій.
function sizeOf(id) {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/i);
  return m ? Number.parseFloat(m[1]) : 0;
}

export function pickChatModels(list) {
  return list
    .filter((m) => m && typeof m.id === 'string' && m.active !== false && !NON_CHAT.test(m.id))
    .sort((a, b) => sizeOf(b.id) - sizeOf(a.id) || (b.context_window ?? 0) - (a.context_window ?? 0))
    .map((m) => m.id);
}

function parseRetryAfter(value) {
  if (value == null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export class OpenAICompatProvider {
  constructor({
    baseUrl,
    apiKey,
    models,
    label = 'openai-compatible',
    fetchImpl = globalThis.fetch,
    sleep = sleepDefault,
    maxRetries = 2,
    maxWaitMs = 20000,
    timeoutMs = 60000
  }) {
    if (!baseUrl || !apiKey || !models?.length) {
      throw new Error('Потрібні baseUrl, apiKey і хоча б одна модель');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.models = models;
    this.label = label;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.maxWaitMs = maxWaitMs;
    this.timeoutMs = timeoutMs;
  }

  async complete({ messages, temperature = 0.9, maxTokens = 1800, json = true }) {
    const params = { messages, temperature, maxTokens, json };
    try {
      return await this.#tryModels(this.models, params);
    } catch (e) {
      // Усі задані моделі зникли в провайдера: підбираємо з його актуального списку.
      if (!(e instanceof ProviderError) || e.code !== 'model_not_found' || this.discovered) throw e;
      this.discovered = true;
      const found = (await this.#listModels()).filter((m) => !this.models.includes(m)).slice(0, 2);
      if (!found.length) throw e;
      console.warn(`[${this.label}] задані моделі недоступні, використовую: ${found.join(', ')}`);
      this.models = found;
      return await this.#tryModels(this.models, params);
    }
  }

  async #tryModels(models, params) {
    let last;
    for (let i = 0; i < models.length; i++) {
      try {
        return await this.#callModel(models[i], params);
      } catch (e) {
        last = e;
        const canFallBack = e instanceof ProviderError && (e.code === 'rate_limited' || e.code === 'model_not_found');
        if (canFallBack && i < models.length - 1) continue;
        throw e;
      }
    }
    throw last;
  }

  async #listModels() {
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!resp.ok) return [];
      const data = await safeJson(resp);
      return pickChatModels(Array.isArray(data?.data) ? data.data : []);
    } catch {
      return [];
    }
  }

  async #callModel(model, { messages, temperature, maxTokens, json }) {
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };

    for (let i = 0; ; i++) {
      let resp;
      try {
        resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (e) {
        const why = e?.name === 'TimeoutError' ? 'таймаут' : e?.message ?? 'невідома помилка';
        throw new ProviderError('network', `Не вдалося зв’язатися з провайдером: ${why}`);
      }

      if (resp.ok) {
        const data = await safeJson(resp);
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) {
          throw new ProviderError('bad_response', 'Провайдер повернув порожню відповідь');
        }
        return {
          text,
          model: data.model ?? model,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0
          }
        };
      }

      const errBody = await safeJson(resp);
      const status = resp.status;
      const apiCode = errBody?.error?.code;
      const apiMessage = errBody?.error?.message ?? '';

      // Модель є в /models, але заблокована для цієї організації або проєкту: для нас це «недоступна».
      const blocked = status === 403 && /^model_permission_blocked/.test(apiCode ?? '');
      if ((status === 401 || status === 403) && !blocked) {
        throw new ProviderError('auth', `Провайдер відхилив API-ключ (HTTP ${status}). Перевірте ключ у файлі .env.`);
      }
      if (blocked || apiCode === 'model_not_found' || apiCode === 'model_decommissioned' || (status === 404 && /model/i.test(apiMessage))) {
        throw new ProviderError(
          'model_not_found',
          `Модель «${model}» недоступна. Перевірте назву моделі в консолі провайдера й змініть її у .env.`
        );
      }
      if (status === 429 || status >= 500) {
        const retryAfterSec = status === 429 ? parseRetryAfter(resp.headers.get('retry-after')) : null;
        const waitMs = retryAfterSec != null ? retryAfterSec * 1000 : 1000 * 2 ** i;
        const tooLong = status === 429 && waitMs > this.maxWaitMs;
        if (tooLong || i >= this.maxRetries) {
          if (status === 429) {
            const when =
              retryAfterSec == null
                ? 'Спробуйте трохи пізніше.'
                : retryAfterSec >= 120
                  ? `Спробуйте приблизно через ${Math.ceil(retryAfterSec / 60)} хв (імовірно, вичерпано добовий ліміт токенів).`
                  : `Спробуйте приблизно через ${Math.ceil(retryAfterSec)} с.`;
            throw new ProviderError('rate_limited', `Ліміт безкоштовного тарифу вичерпано для моделі «${model}». ${when}`, {
              retryAfterSec
            });
          }
          throw new ProviderError('upstream', `Помилка провайдера (HTTP ${status}). ${apiMessage}`.trim());
        }
        await this.sleep(waitMs);
        continue;
      }
      if (status === 400 && apiCode === 'json_validate_failed') {
        throw new ProviderError('bad_response', 'Модель не змогла сформувати коректний JSON');
      }
      if (status === 404) {
        throw new ProviderError('upstream', 'Ендпоінт не знайдено (HTTP 404). Перевірте LLM_BASE_URL.');
      }
      throw new ProviderError('upstream', `Помилка провайдера (HTTP ${status}). ${apiMessage}`.trim());
    }
  }
}
