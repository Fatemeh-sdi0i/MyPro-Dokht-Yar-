/*
 * تنظیمات اجرا.
 * remote: false  → حالت محلی (پیش‌فرض)؛ داده‌ها در همین مرورگر ذخیره می‌شوند.
 * remote: true   → حالت سرور؛ داده‌ها از API دوخت‌یار خوانده و نوشته می‌شوند.
 * apiBase: آدرس پایه‌ی API؛ خالی یعنی همان مبدأ (وقتی Nginx هم سایت و هم API را سرو می‌کند).
 * اگر پیش از این فایل مقداری تنظیم شده باشد (مثلاً در آزمون)، همان حفظ می‌شود.
 */
window.DOKHTYAR_CONFIG = Object.assign({ remote: false, apiBase: "" }, window.DOKHTYAR_CONFIG || {});
