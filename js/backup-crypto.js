// پشتیبان رمزشده‌ی دوخت‌یار (اختیاری، کنار پشتیبان ساده‌ی قدیمی).
// قالب (نسخه‌ی ۱):
//   {
//     "format": "dokhtyar-encrypted-backup",
//     "version": 1,
//     "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": <عدد>, "salt": "<base64، ۱۶ بایت>" },
//     "cipher": { "name": "AES-GCM", "iv": "<base64، ۱۲ بایت>" },
//     "createdAt": "<زمان ISO>",
//     "data": "<base64: متن رمزشده به‌همراه برچسب AES-GCM ۱۲۸ بیتی>"
//   }
// متن رمزشده همان JSON پشتیبان ساده است؛ پس بعد از رمزگشایی با همان اعتبارسنجی فایل ساده بررسی می‌شود.
// سرآیند کامل (به‌جز data) به‌عنوان AAD به رمز بسته می‌شود؛ هر تغییری در آن رمزگشایی را شکست می‌دهد.
// هیچ داده‌ای جز متن رمزشده در فایل نیست؛ گذرواژه هرگز ذخیره یا فرستاده نمی‌شود.
(function (root) {
  "use strict";

  const FORMAT = "dokhtyar-encrypted-backup";
  const VERSION = 1;
  const KDF_NAME = "PBKDF2";
  const HASH = "SHA-256";
  const CIPHER = "AES-GCM";
  const DEFAULT_ITERATIONS = 600000;
  const MIN_ITERATIONS = 100000; // کمتر از این برای PBKDF2 امن نیست
  const MAX_ITERATIONS = 10000000; // سقف برای جلوگیری از فایل‌های با هزینه‌ی بی‌نهایت
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const TAG_BYTES = 16;
  const MIN_PASSWORD_CHARS = 8;
  const MAX_TEXT_CHARS = 50 * 1024 * 1024;
  const LIST_KEYS = ["customers", "orders", "staff", "transactions"];

  class BackupError extends Error {
    constructor(code, message) { super(message); this.name = "BackupError"; this.code = code; }
  }

  const te = new TextEncoder();
  const td = new TextDecoder("utf-8", { fatal: true });

  function subtle() {
    const c = (root.crypto || globalThis.crypto);
    if (!c || !c.subtle) throw new BackupError("no_crypto", "این مرورگر رمزنگاری را پشتیبانی نمی‌کند");
    return c;
  }

  function toB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  // نامعتبر بودن base64 را خطای قالب می‌گیرد، نه خطای برنامه
  function fromB64(text, expectedLength) {
    if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
      throw new BackupError("corrupt", "فایل خراب است یا قالب آن شناخته نشد.");
    }
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    if (expectedLength !== undefined && out.length !== expectedLength) {
      throw new BackupError("corrupt", "فایل خراب است یا قالب آن شناخته نشد.");
    }
    return out;
  }

  function corrupt(message) {
    return new BackupError("corrupt", message || "فایل خراب است یا قالب آن شناخته نشد.");
  }

  // ---------- تجزیه‌ی متن ساده‌ی پشتیبان (هر دو شکل قدیمی) ----------
  // شکل محلی: کل وضعیت برنامه (settings + فهرست‌ها)؛ شکل سرور: exported_at + shop + فهرست‌ها.
  function countsOf(data) {
    return LIST_KEYS.reduce((acc, k) => { acc[k] = data[k].length; return acc; }, {});
  }

  function parseBackup(text) {
    if (typeof text !== "string" || text.length === 0) throw corrupt("فایل خالی است.");
    if (text.length > MAX_TEXT_CHARS) throw new BackupError("too_large", "فایل بیش از حد بزرگ است.");
    let data;
    try { data = JSON.parse(text); } catch (e) { throw corrupt("فایل JSON معتبر نیست."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw corrupt("ساختار پشتیبان شناخته نشد.");
    for (const k of LIST_KEYS) {
      if (!Array.isArray(data[k]) || data[k].some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
        throw corrupt(`بخش «${k}» در پشتیبان معتبر نیست.`);
      }
    }
    let kind;
    if ("exported_at" in data || "shop" in data) kind = "server";
    else if ("settings" in data) kind = "local";
    else throw corrupt("ساختار پشتیبان شناخته نشد.");
    return { kind, data, counts: countsOf(data) };
  }

  // ---------- سرآیند و AAD ----------
  function canonicalHeader(h) {
    return JSON.stringify({
      format: h.format,
      version: h.version,
      kdf: { name: h.kdf.name, hash: h.kdf.hash, iterations: h.kdf.iterations, salt: h.kdf.salt },
      cipher: { name: h.cipher.name, iv: h.cipher.iv },
      createdAt: h.createdAt,
    });
  }

  async function deriveKey(password, salt, iterations) {
    const c = subtle();
    const base = await c.subtle.importKey("raw", te.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
    return c.subtle.deriveKey(
      { name: KDF_NAME, salt, iterations, hash: HASH },
      base,
      { name: CIPHER, length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  function faDigits(n) { return String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]); }

  function checkPassword(password) {
    if (typeof password !== "string" || [...password].length < MIN_PASSWORD_CHARS) {
      throw new BackupError("weak_password", `گذرواژه باید حداقل ${faDigits(MIN_PASSWORD_CHARS)} نویسه باشد.`);
    }
  }

  /**
   * رمزنگاری متن پشتیبان ساده. متن ورودی باید خودش پشتیبان معتبر باشد (برای جلوگیری از رمزکردن خروجی خراب).
   * هر بار نمک و IV تازه ساخته می‌شود.
   */
  async function encryptBackup(plainText, password, options) {
    checkPassword(password);
    parseBackup(plainText); // اگر متن معتبر نباشد، خطا
    const iterations = (options && options.iterations) || DEFAULT_ITERATIONS;
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new BackupError("corrupt", "تعداد تکرار نامعتبر است.");
    }
    const c = subtle();
    const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
    const header = {
      format: FORMAT,
      version: VERSION,
      kdf: { name: KDF_NAME, hash: HASH, iterations, salt: toB64(salt) },
      cipher: { name: CIPHER, iv: toB64(iv) },
      createdAt: new Date().toISOString(),
    };
    const key = await deriveKey(password, salt, iterations);
    const ct = await c.subtle.encrypt(
      { name: CIPHER, iv, additionalData: te.encode(canonicalHeader(header)), tagLength: TAG_BYTES * 8 },
      key,
      te.encode(plainText),
    );
    return JSON.stringify({ ...header, data: toB64(new Uint8Array(ct)) }, null, 2);
  }

  /** فایل پشتیبان رمزشده را بررسی و رمزگشایی می‌کند. هیچ‌چیزی ذخیره یا تغییر نمی‌دهد. */
  async function decryptBackup(fileText, password) {
    if (typeof fileText !== "string" || fileText.length === 0) throw corrupt("فایل خالی است.");
    if (fileText.length > MAX_TEXT_CHARS) throw new BackupError("too_large", "فایل بیش از حد بزرگ است.");
    let obj;
    try { obj = JSON.parse(fileText); } catch (e) { throw corrupt("فایل JSON معتبر نیست."); }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw corrupt("ساختار فایل شناخته نشد.");
    if (obj.format !== FORMAT) {
      if (!("format" in obj)) throw new BackupError("not_encrypted", "این فایل رمزشده نیست.");
      throw corrupt("ساختار فایل شناخته نشد.");
    }
    if (obj.version !== VERSION) {
      if (Number.isInteger(obj.version) && obj.version > VERSION) {
        throw new BackupError("unsupported_version", `نسخه‌ی ${obj.version} این فایل پشتیبانی نمی‌شود؛ با نسخه‌ی جدیدتر برنامه باز کنید.`);
      }
      if (Number.isInteger(obj.version)) {
        throw new BackupError("unsupported_version", `نسخه‌ی ${obj.version} این فایل پشتیبانی نمی‌شود.`);
      }
      throw corrupt();
    }
    if (!obj.kdf || obj.kdf.name !== KDF_NAME || obj.kdf.hash !== HASH) {
      throw new BackupError("unsupported_kdf", "روش رمزنگاری این فایل پشتیبانی نمی‌شود.");
    }
    if (!obj.cipher || obj.cipher.name !== CIPHER) {
      throw new BackupError("unsupported_cipher", "روش رمزنگاری این فایل پشتیبانی نمی‌شود.");
    }
    const iterations = obj.kdf.iterations;
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw corrupt("تعداد تکرار در فایل نامعتبر است.");
    }
    const salt = fromB64(obj.kdf.salt, SALT_BYTES);
    const iv = fromB64(obj.cipher.iv, IV_BYTES);
    const ct = fromB64(obj.data);
    if (ct.length < TAG_BYTES) throw corrupt();
    if (createdAtOk(obj.createdAt) === null) throw corrupt("تاریخ ساخت فایل نامعتبر است.");
    if (typeof password !== "string" || password.length === 0) {
      throw new BackupError("no_password", "گذرواژه‌ی این فایل رمزشده را وارد کنید.");
    }

    const key = await deriveKey(password, salt, iterations);
    let plainBuf;
    try {
      plainBuf = await subtle().subtle.decrypt(
        { name: CIPHER, iv, additionalData: te.encode(canonicalHeader(obj)), tagLength: TAG_BYTES * 8 },
        key,
        ct,
      );
    } catch (e) {
      // AES-GCM نادرست بودن گذرواژه و خراب بودن فایل را جدا نمی‌کند؛ هر دو همین پیام را می‌گیرند
      throw new BackupError("decrypt_failed", "گذرواژه نادرست است یا فایل خراب شده است.");
    }
    let text;
    try { text = td.decode(plainBuf); } catch (e) { throw corrupt(); }
    const parsed = parseBackup(text);
    return { ...parsed, createdAt: obj.createdAt, plainText: text };
  }

  function createdAtOk(value) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
    return value;
  }

  root.BackupCrypto = {
    FORMAT,
    VERSION,
    MIN_PASSWORD_CHARS,
    DEFAULT_ITERATIONS,
    MIN_ITERATIONS,
    BackupError,
    parseBackup,
    encryptBackup,
    decryptBackup,
  };
})(typeof window !== "undefined" ? window : globalThis);
