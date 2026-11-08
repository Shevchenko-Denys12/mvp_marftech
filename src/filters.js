// Детерміновані перевірки кандидатів після моделі: довжина, заборонені формулювання,
// вигадані числа, повтори й копіювання оригіналу. Модель тут не потрібна,
// тож результат повторюваний і його легко пояснити.

const LIMIT_KEY = {
  hook: 'hookMaxWords',
  first_line: 'firstLineMaxWords',
  on_screen: 'onScreenMaxWords'
};

export function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

export function wordCount(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function tokens(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function splitSentences(script) {
  return String(script ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => tokens(s).length >= 3);
}

export function compileRules(rules) {
  return {
    ...rules,
    forbidden: (rules.forbidden ?? []).map((r) => ({
      re: new RegExp(r.pattern, r.flags ?? 'i'),
      reason: r.reason,
      hint: r.hint ?? r.reason
    }))
  };
}

const fail = (code, reason, hint) => ({ ok: false, code, reason, hint: hint ?? reason });

// item: {type, text}; ctx: {limits, rules (compileRules), accepted (того ж типу), originalSentences}
export function checkCandidate(item, ctx) {
  const { limits, rules, accepted = [], originalSentences = [] } = ctx;
  const text = normalize(item.text);

  if (!text) return fail('empty', 'Порожній текст');
  if (/\p{Extended_Pictographic}/u.test(text)) return fail('emoji', 'Емодзі не допускаються', 'no emojis');
  if (/(^|\s)#\w/.test(text)) return fail('hashtag', 'Хештеги не допускаються', 'no hashtags');

  const words = wordCount(text);
  const maxWords = limits[LIMIT_KEY[item.type]];
  if (words > maxWords) {
    return fail('too_long', `${words} слів при ліміті ${maxWords}`, `too long: ${words} words, limit is ${maxWords}`);
  }
  if (item.type === 'on_screen' && text.length > limits.onScreenMaxChars) {
    return fail(
      'too_long',
      `${text.length} символів при ліміті ${limits.onScreenMaxChars}`,
      `too long: ${text.length} characters, limit is ${limits.onScreenMaxChars}`
    );
  }

  for (const rule of rules.forbidden) {
    if (rule.re.test(text)) return fail('forbidden', rule.reason, rule.hint);
  }

  if (/\d+\s?%/.test(text)) {
    return fail('invented_number', 'Вигадана статистика (відсотки)', 'no invented percentages');
  }
  const allowed = new Set((rules.allowedPrices ?? []).map((p) => p.replace(/\s/g, '')));
  // Кома після суми («$29, and…») не частина числа; тисячні розділювачі ($1,000) враховуємо.
  for (const m of text.match(/\$\s?\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []) {
    const price = m.replace(/\s/g, '');
    if (!allowed.has(price)) {
      return fail(
        'invented_number',
        `Згадана ціна ${price}, дозволено лише ${[...allowed].join(', ') || 'жодної'}`,
        `price ${price} is not in the offer; only ${[...allowed].join(', ')} is allowed`
      );
    }
  }

  const tk = tokens(text);
  const joined = tk.join(' ');
  for (const s of originalSentences) {
    const st = tokens(s);
    if (st.join(' ') === joined || jaccard(tk, st) >= rules.originalSimilarityThreshold) {
      return fail('copies_original', 'Повторює речення з оригінального скрипта', 'copies a sentence from the original script');
    }
  }
  for (const a of accepted) {
    if (jaccard(tk, tokens(a.text)) >= rules.similarityThreshold) {
      return fail('near_duplicate', `Надто схоже на «${a.text}»`, `too similar to "${a.text}"`);
    }
  }

  return { ok: true, text };
}
