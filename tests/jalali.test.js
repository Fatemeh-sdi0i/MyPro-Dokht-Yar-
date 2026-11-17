const { test } = require('node:test');
const assert = require('node:assert/strict');
const J = require('../js/jalali.js');

const iso = ({ gy, gm, gd }) => `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;

test('Nowruz (1 Farvardin) dates match the known Gregorian dates', () => {
  assert.equal(iso(J.jalaliToGregorian(1399, 1, 1)), '2020-03-20');
  assert.equal(iso(J.jalaliToGregorian(1400, 1, 1)), '2021-03-21');
  assert.equal(iso(J.jalaliToGregorian(1403, 1, 1)), '2024-03-20');
  assert.equal(iso(J.jalaliToGregorian(1404, 1, 1)), '2025-03-21');
  assert.equal(iso(J.jalaliToGregorian(1405, 1, 1)), '2026-03-21');
});

test('last day of Esfand 1404 is the day before Nowruz 1405', () => {
  assert.equal(iso(J.jalaliToGregorian(1404, 12, 29)), '2026-03-20');
});

test('round trip d2g(g2d(x)) is the identity over a long range', () => {
  for (let n = 736000; n < 740000; n += 7) {
    const g = J.d2g(n);
    assert.equal(J.g2d(g.gy, g.gm, g.gd), n);
  }
});

test('Persian and English digits both work; invalid input returns null or throws', () => {
  assert.equal(J.jalaliStringToISO('۱۴۰۵/۰۸/۱۴'), '2026-11-05');
  assert.equal(J.jalaliStringToISO('1405/08/14'), '2026-11-05');
  assert.equal(J.jalaliStringToISO('abc'), null);
  assert.throws(() => J.jalaliToGregorian(1405, 13, 1), RangeError);
});

test('today (2026-11-17) is 1405/08/26 — the prototype constant 1405/08/16 was 10 days off', () => {
  assert.equal(iso(J.jalaliToGregorian(1405, 8, 26)), '2026-11-17');
  assert.equal(iso(J.jalaliToGregorian(1405, 8, 16)), '2026-11-07');
});
