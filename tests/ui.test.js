import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRange, fmtDayRow, fmtDayYear, parseNum } from '../js/ui.js';

test('fmtRange: same month, same year, across years, single day', () => {
  assert.equal(fmtRange('2026-06-10', '2026-06-14'), '10–14 giu 2026');
  assert.equal(fmtRange('2026-06-30', '2026-07-02'), '30 giu – 2 lug 2026');
  assert.equal(fmtRange('2025-12-30', '2026-01-02'), '30 dic 2025 – 2 gen 2026');
  assert.equal(fmtRange('2026-06-10', '2026-06-10'), '10 giu 2026');
});

test('fmtDayRow / fmtDayYear', () => {
  assert.equal(fmtDayRow('2026-06-10'), 'Mer 10 giugno');
  assert.equal(fmtDayYear('2026-06-10'), 'Mercoledì 10 giugno 2026');
});

test('parseNum: Italian and plain numbers, garbage → NaN', () => {
  for (const [s, n] of [['1.234,50', 1234.5], ['12,5', 12.5], ['12.5', 12.5], ['12', 12], ['0,5', 0.5], ['.5', 0.5], [' 1.200,00 ', 1200],
    ['1.234', 1234], ['1.234.567,8', 1234567.8], [1500, 1500]]) {
    assert.equal(parseNum(s), n, String(s));
  }
  for (const s of ['12abc', 'abc', '', '  ', '1,2,3', '1,234.5', '--1', '1e3', '12 €', '-5', null, undefined]) {
    assert.ok(Number.isNaN(parseNum(s)), String(s));
  }
});
