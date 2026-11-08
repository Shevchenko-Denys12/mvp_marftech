// Harness навколо моделі: що ми робимо до, під час і після виклику LLM.
//
//   запит -> валідація входу -> [промпт -> модель -> розбір JSON -> фільтри -> добір бракуючого] x до 3 -> результат
//
// Модель лише пропонує кандидатів. Рішення про те, що потрапить до дизайнера,
// ухвалюють детерміновані правила (filters.js), а не модель.

import { TYPES, extractJson, validateOutput } from './schema.js';
import { checkCandidate, splitSentences, normalize, wordCount } from './filters.js';
import { buildMessages } from './prompt.js';
import { HarnessError, ProviderError } from './errors.js';

export const DEFAULT_COUNTS = { hook: 5, first_line: 5, on_screen: 5 };
export const MAX_PER_TYPE = 10;
export const MAX_TOTAL = 24;
export const SCRIPT_MIN = 40;
export const SCRIPT_MAX = 6000;

const sum = (o) => TYPES.reduce((s, t) => s + o[t], 0);

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HarnessError('bad_request', 'Тіло запиту має бути JSON-об’єктом');
  }
  const script = typeof body.script === 'string' ? body.script.replace(/\r\n/g, '\n').trim() : '';
  if (script.length < SCRIPT_MIN) {
    throw new HarnessError('bad_request', `Скрипт занадто короткий: потрібно щонайменше ${SCRIPT_MIN} символів`);
  }
  if (script.length > SCRIPT_MAX) {
    throw new HarnessError('bad_request', `Скрипт занадто довгий: максимум ${SCRIPT_MAX} символів`);
  }

  const counts = {};
  for (const t of TYPES) {
    const n = Number(body.counts?.[t] ?? DEFAULT_COUNTS[t]);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PER_TYPE) {
      throw new HarnessError('bad_request', `Кількість «${t}» має бути цілим числом від 0 до ${MAX_PER_TYPE}`);
    }
    counts[t] = n;
  }
  const total = sum(counts);
  if (total < 1) throw new HarnessError('bad_request', 'Оберіть хоча б один варіант для генерації');
  if (total > MAX_TOTAL) throw new HarnessError('bad_request', `Разом не більше ${MAX_TOTAL} варіантів за один запуск`);

  return { script, counts };
}

// rules має бути пропущений через compileRules()
export async function generateVariants({ script, counts, provider, brand, rules, maxAttempts = 3, temperature = 0.9 }) {
  const startedAt = Date.now();
  const accepted = { hook: [], first_line: [], on_screen: [] };
  const rejected = [];
  const warnings = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  const originalSentences = splitSentences(script);

  let analysis = null;
  let model = null;
  let calls = 0;
  let parsedAny = false;
  let feedback = [];

  const remaining = () => Object.fromEntries(TYPES.map((t) => [t, Math.max(0, counts[t] - accepted[t].length)]));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rem = remaining();
    if (sum(rem) === 0) break;

    // Просимо трохи більше, ніж потрібно: частину кандидатів відсіють фільтри.
    const ask = Object.fromEntries(
      TYPES.map((t) => {
        if (rem[t] === 0) return [t, 0];
        const extra = attempt === 1 ? Math.min(3, Math.max(1, Math.ceil(rem[t] * 0.3))) : 1;
        return [t, rem[t] + extra];
      })
    );
    const avoid = TYPES.flatMap((t) => accepted[t].map((i) => i.text));
    const messages = buildMessages({ script, brand, need: ask, avoid, feedback });

    let res;
    try {
      res = await provider.complete({
        messages,
        temperature,
        maxTokens: 1800,
        json: true,
        meta: { need: ask, script, attempt }
      });
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'bad_response' && attempt < maxAttempts) {
        calls++;
        warnings.push(`Спроба ${attempt}: провайдер повернув некоректну відповідь, повторюю`);
        feedback = ['Your previous reply could not be processed. Return only one valid JSON object.'];
        continue;
      }
      throw e;
    }
    calls++;
    usage.promptTokens += res.usage?.promptTokens ?? 0;
    usage.completionTokens += res.usage?.completionTokens ?? 0;
    model = res.model ?? model;

    let parsed;
    try {
      parsed = extractJson(res.text);
    } catch (e) {
      warnings.push(`Спроба ${attempt}: відповідь не вдалося розібрати (${e.message})`);
      feedback = ['Your previous reply was not valid JSON. Return only one JSON object with the requested shape.'];
      continue;
    }
    const v = validateOutput(parsed);
    if (!v.ok) {
      warnings.push(`Спроба ${attempt}: у відповіді немає придатних варіантів (${v.errors.join('; ') || 'порожньо'})`);
      feedback = ['Your previous reply had no usable variations. Use the exact JSON shape from the instructions.'];
      continue;
    }
    parsedAny = true;
    if (!analysis && v.analysis) analysis = v.analysis;

    const rejectedNow = [];
    for (const item of v.items) {
      // Надлишок понад замовлене просто ігноруємо.
      if (accepted[item.type].length >= counts[item.type]) continue;
      const check = checkCandidate(item, {
        limits: brand.limits,
        rules,
        accepted: accepted[item.type],
        originalSentences
      });
      if (check.ok) {
        accepted[item.type].push({
          type: item.type,
          text: check.text,
          angle: item.angle,
          words: wordCount(check.text),
          chars: check.text.length,
          attempt
        });
      } else {
        const r = { type: item.type, text: normalize(item.text), angle: item.angle, code: check.code, reason: check.reason };
        rejected.push(r);
        rejectedNow.push({ ...r, hint: check.hint });
      }
    }
    feedback = rejectedNow.slice(0, 8).map((r) => `${r.type} "${r.text}" was rejected: ${r.hint}`);
  }

  if (!parsedAny) {
    throw new ProviderError('bad_response', `Модель не повернула придатних варіантів після ${calls} спроб(и). Спробуйте ще раз.`);
  }

  const rem = remaining();
  if (sum(rem) > 0) {
    const missing = TYPES.filter((t) => rem[t] > 0)
      .map((t) => `${t}: ${rem[t]}`)
      .join(', ');
    warnings.push(`Отримано не всі варіанти, бракує: ${missing}. Спробуйте запустити ще раз.`);
  }

  const variants = {};
  for (const t of TYPES) {
    variants[t] = accepted[t].map((item, i) => ({ id: `${t}-${i + 1}`, ...item }));
  }

  return {
    analysis,
    variants,
    rejected,
    warnings,
    stats: {
      provider: provider.label ?? 'unknown',
      model,
      attempts: calls,
      ms: Date.now() - startedAt,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      requested: sum(counts),
      accepted: sum(Object.fromEntries(TYPES.map((t) => [t, accepted[t].length]))),
      rejected: rejected.length
    }
  };
}
