# استقرار دوخت‌یار

> **وضعیت:** این فایل‌ها آماده‌اند، اما هنوز هیچ سروری خریداری یا راه‌اندازی نشده است. تا تأیید صریح شما، هیچ هزینه‌ای ایجاد نمی‌شود.

## فایل‌ها
- `deploy.sh`: به‌روزرسانی کد، نصب وابستگی‌ها، مهاجرت پایگاه داده، راه‌اندازی مجدد و بررسی سلامت. idempotent است.
- `dokhtyar.service`: واحد systemd؛ کاربر مجزای `dokhtyar`، با محدودیت‌های امنیتی.
- `nginx.conf.example`: پروکسی HTTPS با گواهی رایگان Let's Encrypt.

## مراحل (وقتی سرور تأیید شد)
1. کاربر و مسیرها: `useradd --system dokhtyar`، کلون مخزن در `/opt/dokhtyar`.
2. PostgreSQL 16 و ساخت پایگاه داده و کاربر با گذرواژه‌ی قوی.
3. فایل `/etc/dokhtyar/env` با مقادیر `DATABASE_URL`، `HOST=127.0.0.1`، `PORT=3000`، `NODE_ENV=production`، `TRUST_PROXY=1`. دسترسی فایل: `chmod 600`.
4. نصب واحد systemd و Nginx با گواهی Let's Encrypt.
5. ساخت اولین مدیر: `node backend/scripts/create-admin.js` با `ADMIN_PASSWORD` از محیط.
6. اجرای `deploy.sh`.

## نکات امنیتی
- داده‌ی واقعی مشتری تا تصمیم جداگانه‌ی شما روی سرور ذخیره نمی‌شود.
- نشست‌ها در کوکی `HttpOnly` و `SameSite=Strict` و در حالت production با `Secure` هستند.
- گذرواژه با scrypt هش می‌شود (نه argon2id؛ دلیل در PR شماره ۴ آمده است).
