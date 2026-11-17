/*
 * تبدیل تاریخ شمسی ↔ میلادی (الگوریتم جدول‌محور، مشابه کتابخانه‌ی jalaali-js).
 * فقط برای تبدیل داده‌های قدیمی و نمایش؛ منبع حقیقت در سرور تاریخ میلادی است.
 */
(function (root) {
  const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const div = (a, b) => Math.trunc(a / b);
  const mod = (a, b) => a - Math.trunc(a / b) * b;

  function jalCalMarch(jy) {
    let jp = BREAKS[0];
    let jump = 0;
    let leapJ = -14;
    for (let i = 1; i < BREAKS.length; i++) {
      const jm = BREAKS[i];
      jump = jm - jp;
      if (jy < jm) break;
      leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
      jp = jm;
    }
    const n = jy - jp;
    leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
    if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
    const gy = jy + 621;
    const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
    return 20 + leapJ - leapG;
  }

  // روز ژولیانی از تاریخ میلادی
  function g2d(gy, gm, gd) {
    let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4)
      + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
    return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  }

  // تاریخ میلادی از روز ژولیانی
  function d2g(jdn) {
    let j = 4 * jdn + 139361631;
    j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
    const i = div(mod(j, 1461), 4) * 5 + 308;
    const gd = div(mod(i, 153), 5) + 1;
    const gm = mod(div(i, 153), 12) + 1;
    const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
    return { gy, gm, gd };
  }

  function jalaliToDay(jy, jm, jd) {
    const march = jalCalMarch(jy);
    const gy = jy + 621;
    return g2d(gy, 3, march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  }

  // ورودی: jy/jm/jd عددی؛ خروجی: { gy, gm, gd }
  function jalaliToGregorian(jy, jm, jd) {
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) throw new RangeError('تاریخ شمسی نامعتبر است');
    const jdn = jalaliToDay(jy, jm, jd);
    const g = d2g(jdn);
    return g;
  }

  // ورودی/خروجی رشته‌ی ISO میلادی (YYYY-MM-DD) و شمسی به شکل YYYY/MM/DD (ارقام انگلیسی یا فارسی)
  function jalaliStringToISO(s) {
    const en = String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(en.trim());
    if (!m) return null;
    const { gy, gm, gd } = jalaliToGregorian(+m[1], +m[2], +m[3]);
    return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  }

  const api = { jalaliToGregorian, jalaliStringToISO, g2d, d2g };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Jalali = api;
})(typeof window !== 'undefined' ? window : globalThis);
