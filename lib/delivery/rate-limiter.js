"use strict";

/**
 * Token-bucket rate limiter per provider domain.
 *
 * Config shape (from config.rateLimits):
 *   {
 *     "default":      { perMinute: 30, perHour: 500 },
 *     "gmail.com":    { perMinute: 10, perHour: 200 },
 *     "outlook.com":  { perMinute: 10, perHour: 200 }
 *   }
 */
class RateLimiter {
  constructor(rateLimitsConfig = {}) {
    this.config = {
      default:       { perMinute: 30, perHour: 500 },
      "gmail.com":   { perMinute: 10, perHour: 200 },
      "outlook.com": { perMinute: 10, perHour: 200 },
      "hotmail.com": { perMinute: 10, perHour: 200 },
      "yahoo.com":   { perMinute: 10, perHour: 200 },
      ...rateLimitsConfig,
    };
    // counters: domain → { minute: [timestamps], hour: [timestamps] }
    this._counts = {};
  }

  _getLimits(recipientDomain) {
    return this.config[recipientDomain] || this.config["default"];
  }

  _prune(domain) {
    const now  = Date.now();
    const data = this._counts[domain];
    if (!data) return;
    data.minute = data.minute.filter(t => now - t < 60_000);
    data.hour   = data.hour.filter(t => now - t < 3_600_000);
  }

  /**
   * Wait until the per-minute and per-hour limits allow another send.
   * @param {string} recipientDomain  e.g. "gmail.com"
   * @param {object} cancelToken      { cancelled }
   */
  async acquire(recipientDomain, cancelToken = { cancelled: false }) {
    if (!this._counts[recipientDomain]) {
      this._counts[recipientDomain] = { minute: [], hour: [] };
    }

    while (true) {
      if (cancelToken.cancelled) throw new Error("Cancelled");

      this._prune(recipientDomain);
      const { minute, hour } = this._counts[recipientDomain];
      const limits           = this._getLimits(recipientDomain);

      if (minute.length < limits.perMinute && hour.length < limits.perHour) {
        const now = Date.now();
        minute.push(now);
        hour.push(now);
        return;
      }

      // Wait 1s and try again — interruptible by cancel token
      await new Promise((res, rej) => {
        const end = Date.now() + 1000;
        const tick = setInterval(() => {
          if (cancelToken.cancelled) { clearInterval(tick); rej(new Error("Cancelled")); return; }
          if (Date.now() >= end)     { clearInterval(tick); res(); }
        }, 100);
      });
    }
  }

  /** Reset all counters (useful for tests). */
  reset() { this._counts = {}; }
}

module.exports = { RateLimiter };
