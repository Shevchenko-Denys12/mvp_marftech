import { toCsv } from './csv.js';

const TYPES = [
  ['hook', 'Хуки'],
  ['first_line', 'Перші фрази'],
  ['on_screen', 'Текст на екрані']
];

const $ = (sel) => document.querySelector(sel);
const state = { config: null, samples: [], result: null, selected: new Set() };

// Усі дані від сервера й моделі вставляємо лише через textContent, без innerHTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Запасний варіант без inline-атрибутів (CSP їх блокує): стилі через CSSOM.
    const ta = el('textarea');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = button.textContent;
  button.textContent = 'Скопійовано';
  setTimeout(() => (button.textContent = old), 1200);
}

function setMessage(text, isError = false) {
  const msg = $('#msg');
  msg.textContent = text;
  msg.className = isError ? 'msg error' : 'msg';
}

function allVariants() {
  if (!state.result) return [];
  return TYPES.flatMap(([type]) => state.result.variants[type] ?? []);
}

function updateExportButton() {
  const btn = $('#export');
  const items = allVariants();
  btn.hidden = items.length === 0;
  btn.textContent = state.selected.size ? `Експорт CSV (обрано: ${state.selected.size})` : 'Експорт CSV (усі)';
}

function exportCsv() {
  const items = allVariants().filter((v) => state.selected.size === 0 || state.selected.has(v.id));
  const csv = toCsv(items, ['id', 'type', 'text', 'angle', 'words', 'chars']);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `socklock-variants-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderGroup(type, label, items) {
  // Кожна картка реєструє свій checkbox тут, щоб кнопка групи могла обрати їх усі.
  const boxes = [];
  const selectAllBtn = el('button', { type: 'button', text: 'Обрати все' });
  const syncSelectAll = () => {
    selectAllBtn.textContent = boxes.every((b) => b.checked) ? 'Зняти вибір' : 'Обрати все';
  };
  selectAllBtn.addEventListener('click', () => {
    const check = !boxes.every((b) => b.checked);
    for (const b of boxes) {
      if (b.checked !== check) {
        b.checked = check;
        b.dispatchEvent(new Event('change'));
      }
    }
  });

  const head = el(
    'div',
    { class: 'group-head' },
    el('h3', {}, document.createTextNode(label + ' '), el('span', { class: 'count', text: `(${items.length})` })),
    selectAllBtn
  );

  const list = el('ul', { class: 'cards' });
  for (const item of items) {
    const checkbox = el('input', { type: 'checkbox', 'aria-label': 'Обрати для монтажу' });
    boxes.push(checkbox);
    const card = el('li', { class: 'card' });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      card.classList.toggle('selected', checkbox.checked);
      syncSelectAll();
      updateExportButton();
    });
    const meta = el(
      'div',
      { class: 'meta' },
      item.angle ? el('span', { class: 'chip', text: item.angle }) : null,
      el('span', { text: `${item.words} сл.` }),
      el('span', { text: `${item.chars} симв.` })
    );
    // Увесь вміст картки всередині <label>, тож клік у будь-якому місці перемикає checkbox.
    // Кнопка «Копіювати» інтерактивна, тому її клік checkbox не перемикає.
    card.append(
      el(
        'label',
        { class: 'card-body' },
        checkbox,
        el('div', {}, el('p', { class: 'text', text: item.text }), meta),
        el('button', { type: 'button', text: 'Копіювати', onclick: (e) => copyText(item.text, e.currentTarget) })
      )
    );
    list.append(card);
  }
  return el('div', { class: 'group', 'data-type': type }, head, list);
}

function render(result) {
  state.result = result;
  state.selected.clear();
  $('#empty').hidden = true;

  const s = result.stats;
  const tokens = s.promptTokens + s.completionTokens;
  const stats = $('#stats');
  stats.hidden = false;
  stats.textContent =
    `Прийнято ${s.accepted} із ${s.requested} · відхилено правилами ${s.rejected} · ` +
    `викликів моделі ${s.attempts} · ${(s.ms / 1000).toFixed(1)} с · ` +
    `${tokens ? `токени ${tokens} · ` : ''}${s.provider}${s.model ? ` / ${s.model}` : ''}`;

  const warnings = $('#warnings');
  warnings.replaceChildren(...result.warnings.map((w) => el('li', { text: w })));
  warnings.hidden = result.warnings.length === 0;

  const analysis = $('#analysis');
  if (result.analysis) {
    const rows = [
      ['Біль', result.analysis.pain],
      ['Емоція', result.analysis.emotion],
      ['Тип хука', result.analysis.hook_type],
      ['Кут', result.analysis.angle],
      ['CTA', result.analysis.cta]
    ].filter(([, v]) => v);
    analysis.replaceChildren(
      el('summary', { text: 'Що робить оригінальний скрипт (аналіз моделі)' }),
      el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))
    );
    analysis.hidden = false;
  } else {
    analysis.hidden = true;
  }

  $('#results').replaceChildren(
    ...TYPES.filter(([type]) => (result.variants[type] ?? []).length > 0).map(([type, label]) =>
      renderGroup(type, label, result.variants[type])
    )
  );

  const rejected = $('#rejected');
  if (result.rejected.length) {
    rejected.replaceChildren(
      el('summary', { text: `Відхилено правилами (${result.rejected.length})` }),
      el(
        'ul',
        {},
        ...result.rejected.map((r) =>
          el('li', {}, el('div', { class: 'why', text: r.reason }), el('div', { class: 'what', text: `${r.type}: ${r.text}` }))
        )
      )
    );
    rejected.hidden = false;
  } else {
    rejected.hidden = true;
  }

  updateExportButton();
}

function readCounts() {
  const counts = {};
  for (const [type] of TYPES) counts[type] = Number($(`#n-${type}`).value);
  return counts;
}

async function generate() {
  const script = $('#script').value.trim();
  const { scriptMin } = state.config;
  if (script.length < scriptMin) {
    setMessage(`Скрипт занадто короткий: потрібно щонайменше ${scriptMin} символів.`, true);
    return;
  }
  const go = $('#go');
  go.disabled = true;
  go.textContent = 'Генерую…';
  setMessage('');
  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script, counts: readCounts() })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      setMessage(data?.error?.message ?? `Помилка сервера (HTTP ${resp.status})`, true);
      return;
    }
    render(data);
  } catch {
    setMessage('Не вдалося зв’язатися із сервером. Він запущений?', true);
  } finally {
    go.disabled = false;
    go.textContent = 'Згенерувати';
  }
}

function updateScriptHint() {
  const len = $('#script').value.length;
  $('#script-hint').textContent = `${len} / ${state.config.scriptMax} символів`;
}

async function init() {
  const [config, samples] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/samples').then((r) => r.json())
  ]);
  state.config = config;
  state.samples = samples;

  const badge = $('#badge');
  if (config.mock) {
    badge.textContent = 'Режим mock: шаблони, без моделі';
    badge.classList.add('mock');
  } else {
    badge.textContent = `${config.provider} · ${config.model}`;
  }

  for (const [type] of TYPES) {
    const input = $(`#n-${type}`);
    input.value = config.defaults[type];
    input.max = config.maxPerType;
  }

  const select = $('#sample');
  for (const s of samples) select.append(el('option', { value: s.id, text: s.title }));
  select.addEventListener('change', () => {
    const sample = samples.find((s) => s.id === select.value);
    if (sample) $('#script').value = sample.script;
    updateScriptHint();
  });
  if (samples.length) {
    select.value = samples[0].id;
    $('#script').value = samples[0].script;
  }

  $('#script').addEventListener('input', updateScriptHint);
  $('#go').addEventListener('click', generate);
  $('#export').addEventListener('click', exportCsv);
  updateScriptHint();
}

init().catch(() => setMessage('Не вдалося завантажити конфігурацію. Перезапустіть сервер.', true));
