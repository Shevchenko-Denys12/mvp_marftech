// Розбір і перевірка відповіді моделі. Модель може повернути JSON у ```-блоці,
// з зайвим текстом навколо або з частково некоректними елементами,
// тому парсер терпимий, а валідатор повертає і придатні елементи, і список помилок.

export const TYPES = ['hook', 'first_line', 'on_screen'];

export const TYPE_KEYS = {
  hook: 'hooks',
  first_line: 'first_lines',
  on_screen: 'on_screen_texts'
};

export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('порожня відповідь');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // пробуємо вирізати від першої { до останньої }
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('у відповіді немає JSON-об’єкта');
  return JSON.parse(s.slice(start, end + 1));
}

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

export function validateOutput(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['корінь відповіді не є об’єктом'], analysis: null, items: [] };
  }

  const a = obj.analysis && typeof obj.analysis === 'object' ? obj.analysis : null;
  const analysis = a
    ? {
        pain: str(a.pain),
        emotion: str(a.emotion),
        hook_type: str(a.hook_type),
        angle: str(a.angle),
        cta: str(a.cta)
      }
    : null;

  const items = [];
  let sawKey = false;
  for (const type of TYPES) {
    const key = TYPE_KEYS[type];
    const arr = obj[key];
    if (arr === undefined) continue;
    sawKey = true;
    if (!Array.isArray(arr)) {
      errors.push(`${key} не є масивом`);
      continue;
    }
    arr.forEach((el, i) => {
      const text = typeof el === 'string' ? el : el && typeof el.text === 'string' ? el.text : null;
      if (text === null) {
        errors.push(`${key}[${i}] не має поля text`);
        return;
      }
      const angle = el && typeof el === 'object' && typeof el.angle === 'string' ? el.angle.trim().slice(0, 60) : '';
      items.push({ type, text, angle });
    });
  }
  if (!sawKey) errors.push('немає жодного з масивів hooks / first_lines / on_screen_texts');

  return { ok: items.length > 0, errors, analysis, items };
}
