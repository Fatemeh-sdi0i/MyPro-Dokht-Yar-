// آزمون‌های واحد پشتیبان رمزشده (js/backup-crypto.js) و سازگاری با پشتیبان ساده‌ی قدیمی.
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../js/backup-crypto.js");

const BC = globalThis.BackupCrypto;
const FAST = { iterations: BC.MIN_ITERATIONS }; // برای سرعت آزمون؛ کمترین تعداد تکرار مجاز
const PASS = "گذرواژه‌ی-امن-۱۴۰۳";

// شکل محلی: کل وضعیت برنامه (همان چیزی که دکمه‌ی ساده‌ی پشتیبان در حالت محلی دانلود می‌کند)
const localBackup = () => JSON.stringify({
  orders: [{ id: "o1", customer: "مریم-محرمانه", price: 150000 }],
  customers: [{ name: "مریم-محرمانه", phone: "09121112233", note: "یادداشت-محرمانه" }],
  staff: [{ name: "همکار-۱" }],
  transactions: [],
  settings: { shopName: "مزون نمونه", ownerName: "", phone: "", address: "", currency: "تومان" },
}, null, 2);

// شکل سرور: خروجی GET /export
const serverBackup = () => JSON.stringify({
  exported_at: "2026-11-24T06:00:00.000Z",
  shop: { shop_name: "مزون سرور", owner_name: "", phone: "", address: "", currency: "تومان" },
  customers: [{ id: "c1", name: "مشتری-سرور", phone: "09120000000", note: "", tier: "regular", created_at: "2026-11-01" }],
  orders: [],
  staff: [],
  transactions: [],
}, null, 2);

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof BC.BackupError, "خطا باید BackupError باشد");
    assert.equal(err.code, code);
    return true;
  });
}

// یک بایت از متن رمزشده را تغییر می‌دهد (بدون تغییر در سرآیند)
function flipCiphertextByte(fileText) {
  const obj = JSON.parse(fileText);
  const bytes = Buffer.from(obj.data, "base64");
  bytes[0] ^= 0x01;
  obj.data = bytes.toString("base64");
  return JSON.stringify(obj);
}

// ---------- رمزنگاری و رمزگشایی درست ----------

test("گذرواژه‌ی درست: رمزگشایی همان متن پشتیبان را برمی‌گرداند (شکل محلی)", async () => {
  const plain = localBackup();
  const file = await BC.encryptBackup(plain, PASS, FAST);
  const back = await BC.decryptBackup(file, PASS);
  assert.equal(back.plainText, plain);
  assert.equal(back.kind, "local");
  assert.deepEqual(back.counts, { customers: 1, orders: 1, staff: 1, transactions: 0 });
});

test("گذرواژه‌ی درست: شکل سرور هم برمی‌گردد", async () => {
  const file = await BC.encryptBackup(serverBackup(), PASS, FAST);
  const back = await BC.decryptBackup(file, PASS);
  assert.equal(back.kind, "server");
  assert.equal(back.counts.customers, 1);
});

test("فایل رمزشده هیچ نام، تلفن یا یادداشتی را به‌صورت متن ساده ندارد", async () => {
  const file = await BC.encryptBackup(localBackup(), PASS, FAST);
  for (const secret of ["مریم-محرمانه", "09121112233", "یادداشت-محرمانه", "مزون نمونه"]) {
    assert.equal(file.includes(secret), false, `نباید «${secret}» در فایل دیده شود`);
  }
  const obj = JSON.parse(file);
  assert.equal(obj.format, BC.FORMAT);
  assert.equal(obj.version, 1);
  assert.equal(obj.kdf.name, "PBKDF2");
  assert.equal(obj.kdf.hash, "SHA-256");
  assert.equal(obj.cipher.name, "AES-GCM");
});

test("هر رمزنگاری نمک و IV تازه دارد؛ دو فایل از یک متن متفاوت‌اند و هر دو باز می‌شوند", async () => {
  const a = await BC.encryptBackup(localBackup(), PASS, FAST);
  const b = await BC.encryptBackup(localBackup(), PASS, FAST);
  assert.notEqual(a, b);
  assert.notEqual(JSON.parse(a).kdf.salt, JSON.parse(b).kdf.salt);
  assert.notEqual(JSON.parse(a).cipher.iv, JSON.parse(b).cipher.iv);
  assert.equal((await BC.decryptBackup(a, PASS)).plainText, localBackup());
  assert.equal((await BC.decryptBackup(b, PASS)).plainText, localBackup());
});

test("گذرواژه‌ی فارسی و NFC/NFD: هر دو شکل یک گذرواژه را یکسان می‌گیرند", async () => {
  const nfd = "café-secret-1234".normalize("NFD");
  const nfc = "café-secret-1234".normalize("NFC");
  assert.notEqual(nfd, nfc);
  const file = await BC.encryptBackup(localBackup(), nfd, FAST);
  assert.equal((await BC.decryptBackup(file, nfc)).plainText, localBackup());
});

// ---------- گذرواژه‌ی نادرست و قالب ----------

test("گذرواژه‌ی نادرست: خطای decrypt_failed و هیچ متنی برنمی‌گردد", async () => {
  const file = await BC.encryptBackup(localBackup(), PASS, FAST);
  await expectCode(BC.decryptBackup(file, PASS + "x"), "decrypt_failed");
});

test("گذرواژه‌ی خالی در رمزگشایی: خطای no_password", async () => {
  const file = await BC.encryptBackup(localBackup(), PASS, FAST);
  await expectCode(BC.decryptBackup(file, ""), "no_password");
  await expectCode(BC.decryptBackup(file, undefined), "no_password");
});

test("گذرواژه‌ی کوتاه‌تر از حد: رمزنگاری رد می‌شود", async () => {
  await expectCode(BC.encryptBackup(localBackup(), "1234567", FAST), "weak_password");
  await expectCode(BC.encryptBackup(localBackup(), "", FAST), "weak_password");
  await expectCode(BC.encryptBackup(localBackup(), undefined, FAST), "weak_password");
  // هشت نویسه‌ی فارسی کافی است (شمارش بر اساس نویسه)، حتی اگر بایت بیشتری داشته باشد
  const file = await BC.encryptBackup(localBackup(), "گذرواژه۸", FAST);
  assert.ok(file.length > 0);
});

test("فایل خراب: یک بایت تغییریافته، رمزگشایی را شکست می‌دهد", async () => {
  const file = await BC.encryptBackup(localBackup(), PASS, FAST);
  await expectCode(BC.decryptBackup(flipCiphertextByte(file), PASS), "decrypt_failed");
});

test("فایل خراب: کوتاه‌شده یا JSON نامعتبر", async () => {
  const file = await BC.encryptBackup(localBackup(), PASS, FAST);
  await expectCode(BC.decryptBackup(file.slice(0, Math.floor(file.length / 2)), PASS), "corrupt");
  await expectCode(BC.decryptBackup("اصلاً JSON نیست", PASS), "corrupt");
  await expectCode(BC.decryptBackup("", PASS), "corrupt");
  await expectCode(BC.decryptBackup("[1,2,3]", PASS), "corrupt");
});

test("فایل خراب: base64 نامعتبر یا طول نادرست نمک و IV", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  const bad = (mutate) => JSON.stringify(mutate(JSON.parse(JSON.stringify(obj))));
  await expectCode(BC.decryptBackup(bad((o) => { o.data = "!!!"; return o; }), PASS), "corrupt");
  await expectCode(BC.decryptBackup(bad((o) => { o.kdf.salt = "AAAA"; return o; }), PASS), "corrupt");
  await expectCode(BC.decryptBackup(bad((o) => { o.cipher.iv = "AAAA"; return o; }), PASS), "corrupt");
  await expectCode(BC.decryptBackup(bad((o) => { delete o.data; return o; }), PASS), "corrupt");
});

test("سرآیند دستکاری‌شده: تغییر تعداد تکرار یا تاریخ، رمزگشایی را شکست می‌دهد (AAD)", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, kdf: { ...obj.kdf, iterations: BC.MIN_ITERATIONS + 1 } }), PASS), "decrypt_failed");
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, createdAt: "2020-01-01T00:00:00.000Z" }), PASS), "decrypt_failed");
});

test("تاریخ ساخت نامعتبر: خطای قالب", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, createdAt: "دیروز" }), PASS), "corrupt");
});

// ---------- نسخه و روش‌های پشتیبانی‌نشده ----------

test("نسخه‌ی پشتیبانی‌نشده: خطای unsupported_version با شماره‌ی نسخه", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  const v2 = JSON.stringify({ ...obj, version: 2 });
  await assert.rejects(BC.decryptBackup(v2, PASS), (err) => {
    assert.equal(err.code, "unsupported_version");
    assert.match(err.message, /نسخه‌ی 2/);
    return true;
  });
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, version: 0 }), PASS), "unsupported_version");
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, version: "1" }), PASS), "corrupt");
});

test("روش KDF یا رمز پشتیبانی‌نشده: unsupported_kdf و unsupported_cipher", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, kdf: { ...obj.kdf, name: "scrypt" } }), PASS), "unsupported_kdf");
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, kdf: { ...obj.kdf, hash: "SHA-1" } }), PASS), "unsupported_kdf");
  await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, cipher: { ...obj.cipher, name: "AES-CBC" } }), PASS), "unsupported_cipher");
});

test("تعداد تکرار خارج از بازه: corrupt (جلوگیری از هزینه‌ی بی‌نهایت)", async () => {
  const obj = JSON.parse(await BC.encryptBackup(localBackup(), PASS, FAST));
  for (const it of [BC.MIN_ITERATIONS - 1, 10000001, "600000", 1.5]) {
    await expectCode(BC.decryptBackup(JSON.stringify({ ...obj, kdf: { ...obj.kdf, iterations: it } }), PASS), "corrupt");
  }
  await expectCode(BC.encryptBackup(localBackup(), PASS, { iterations: 1000 }), "corrupt");
});

test("فایل ساده‌ی قدیمی به‌عنوان رمزشده: خطای not_encrypted (بدون تغییر)", async () => {
  await expectCode(BC.decryptBackup(localBackup(), PASS), "not_encrypted");
  await expectCode(BC.decryptBackup(serverBackup(), PASS), "not_encrypted");
});

test("فرمت ناشناس با فیلد format متفاوت: corrupt", async () => {
  await expectCode(BC.decryptBackup(JSON.stringify({ format: "other", version: 1 }), PASS), "corrupt");
});

// ---------- سازگاری با پشتیبان ساده‌ی قدیمی ----------

test("سازگاری: پشتیبان ساده‌ی محلی و سرور هر دو با parseBackup پذیرفته می‌شوند", () => {
  const local = BC.parseBackup(localBackup());
  assert.equal(local.kind, "local");
  assert.deepEqual(local.counts, { customers: 1, orders: 1, staff: 1, transactions: 0 });
  const server = BC.parseBackup(serverBackup());
  assert.equal(server.kind, "server");
  assert.equal(server.counts.customers, 1);
});

test("سازگاری: پشتیبان ساده‌ی بدون فهرست یا با ساختار غلط رد می‌شود", () => {
  const bad = [
    "", "اصلاً JSON نیست", "[]", "null", "42",
    JSON.stringify({ settings: {}, customers: "نه-آرایه", orders: [], staff: [], transactions: [] }),
    JSON.stringify({ settings: {}, customers: [1, 2], orders: [], staff: [], transactions: [] }),
    JSON.stringify({ customers: [], orders: [], staff: [], transactions: [] }), // نه settings نه shop
  ];
  for (const text of bad) {
    assert.throws(() => BC.parseBackup(text), (err) => err.code === "corrupt" || err.code === "too_large");
  }
});

test("سازگاری: آنچه رمزگشایی می‌شود همان ساختار ساده‌ی پشتیبان است", async () => {
  const file = await BC.encryptBackup(serverBackup(), PASS, FAST);
  const back = await BC.decryptBackup(file, PASS);
  assert.deepEqual(JSON.parse(back.plainText), JSON.parse(serverBackup()));
});

test("رمزنگاری متن نامعتبر را نمی‌پذیرد (جلوگیری از رمزکردن خروجی خراب)", async () => {
  await expectCode(BC.encryptBackup("{}", PASS, FAST), "corrupt");
  await expectCode(BC.encryptBackup("not json", PASS, FAST), "corrupt");
});
