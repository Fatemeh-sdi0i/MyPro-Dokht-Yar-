/*
 * کلاینت API دوخت‌یار. همه‌ی درخواست‌ها با کوکی نشست (same-origin) ارسال می‌شوند.
 */
(function (root) {
  const cfg = root.DOKHTYAR_CONFIG || {};
  const BASE = String(cfg.apiBase || "").replace(/\/$/, "") + "/api/v1";

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || code);
      this.status = status;
      this.code = code;
    }
  }

  async function request(method, path, body) {
    const init = { method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(BASE + path, init);
    } catch (err) {
      throw new ApiError(0, "network", "اتصال به سرور برقرار نشد");
    }
    let data = null;
    try { data = await res.json(); } catch (err) { /* پاسخ بدون بدنه */ }
    if (!res.ok) {
      throw new ApiError(res.status, (data && data.error) || "http_" + res.status,
        (data && data.message) || "خطا در ارتباط با سرور");
    }
    return data;
  }

  const qs = (params) => {
    const parts = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v));
    return parts.length ? "?" + parts.join("&") : "";
  };

  root.ApiError = ApiError;
  root.Api = {
    call: request,
    me: () => request("GET", "/auth/me"),
    login: (email, password) => request("POST", "/auth/login", { email, password }),
    logout: () => request("POST", "/auth/logout"),

    customers: () => request("GET", "/customers"),
    createCustomer: (body) => request("POST", "/customers", body),

    orders: () => request("GET", "/orders"),
    createOrder: (body) => request("POST", "/orders", body),
    setOrderStatus: (id, to) => request("POST", `/orders/${id}/status`, { to }),

    staff: () => request("GET", "/staff"),
    createStaff: (body) => request("POST", "/staff", body),
    patchStaff: (id, body) => request("PATCH", `/staff/${id}`, body),

    transactions: () => request("GET", "/transactions" + qs({})),
    createTransaction: (body) => request("POST", "/transactions", body),
    deleteTransaction: (id) => request("DELETE", `/transactions/${id}`),
    deletedTransactions: () => request("GET", "/transactions/deleted"),
    restoreTransaction: (id) => request("POST", `/transactions/${id}/restore`),

    settings: () => request("GET", "/settings"),
    saveSettings: (body) => request("PUT", "/settings", body),
    exportJson: () => request("GET", "/export"),
    replaceFromBackup: (body) => request("POST", "/import/replace", body),
    snapshots: () => request("GET", "/import/snapshots"),
    snapshot: (id) => request("GET", `/import/snapshots/${id}`),
  };
})(typeof window !== "undefined" ? window : globalThis);
