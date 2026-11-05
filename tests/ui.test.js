import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRange, fmtDayRow, fmtDayYear } from '../js/ui.js';

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
