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
  // نامعتبر (قالب، ماه ۱ تا ۱۲، یا روزی که در آن ماه وجود ندارد مثل ۳۱ مهر یا ۳۰ اسفند غیرکبیسه) → null
  function jalaliStringToISO(s) {
    const en = String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(en.trim());
    if (!m) return null;
    const jy = +m[1];
    const jm = +m[2];
    const jd = +m[3];
    if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
    const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
    // اعتبارسنجی تقویمی: تبدیل برگشتی باید همان تاریخ را بدهد؛ روز بیش از طول ماه به ماه بعد می‌افتد
    const back = gregorianToJalali(gy, gm, gd);
    if (back.jy !== jy || back.jm !== jm || back.jd !== jd) return null;
    return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  }

  // میلادی → شمسی: خروجی { jy, jm, jd }
  function gregorianToJalali(gy, gm, gd) {
    const jdn = g2d(gy, gm, gd);
    let jy = gy - 621;
    while (jdn < jalaliToDay(jy, 1, 1)) jy--;
    while (jdn >= jalaliToDay(jy + 1, 1, 1)) jy++;
    const diff = jdn - jalaliToDay(jy, 1, 1);
    let jm;
    let jd;
    if (diff < 186) {
      jm = Math.floor(diff / 31) + 1;
      jd = diff - (jm - 1) * 31 + 1;
    } else {
      const r = diff - 186;
      jm = Math.floor(r / 30) + 7;
      jd = r - (jm - 7) * 30 + 1;
    }
    return { jy, jm, jd };
  }

  // میلادی ISO (YYYY-MM-DD) → شمسی به شکل ۱۴۰۵/۰۸/۲۶ (ارقام انگلیسی)
  function isoToJalaliString(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const j = gregorianToJalali(y, m, d);
    return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
  }

  const api = { jalaliToGregorian, jalaliStringToISO, gregorianToJalali, isoToJalaliString, g2d, d2g };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Jalali = api;
})(typeof window !== 'undefined' ? window : globalThis);
