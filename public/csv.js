// Експорт у CSV. Окремий модуль без DOM, щоб його можна було перевірити тестами в Node.

function cell(value) {
  let s = String(value ?? '');
  // Захист від CSV-ін'єкції: Excel/Sheets сприймають такі рядки як формули.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map(cell).join(',');
  const lines = rows.map((row) => columns.map((c) => cell(row[c])).join(','));
  // BOM, щоб Excel правильно відкрив UTF-8
  return '﻿' + [header, ...lines].join('\r\n') + '\r\n';
}
