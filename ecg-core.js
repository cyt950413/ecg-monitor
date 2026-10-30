/* Shared by the browser and Node tests. No network or DOM dependencies. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECG = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const FILTER = Object.freeze({
    fs: 250,
    hz: 60,
    q: 30,
    warmupSamples: 250,
    version: "iirnotch-v1",
  });
  // Digital biquad notch: beta=tan(w0/(2Q)), Q=f0 / -3 dB bandwidth.
  // Matches scipy.signal.iirnotch(f0, Q, fs); unity gain at DC.
  class Notch {
    constructor() {
      const w = (2 * Math.PI * FILTER.hz) / FILTER.fs,
        alpha = Math.tan(w / (2 * FILTER.q)),
        a0 = 1 + alpha;
      this.b0 = 1 / a0;
      this.b1 = (-2 * Math.cos(w)) / a0;
      this.b2 = this.b0;
      this.a1 = this.b1;
      this.a2 = (1 - alpha) / a0;
      this.reset();
    }
    reset() {
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
      this.count = 0;
    }
    next(x) {
      // Constant-input initial conditions avoid a fictitious ADC/DC startup pulse.
      if (!this.count) this.x1 = this.x2 = this.y1 = this.y2 = x;
      const y =
        this.b0 * x +
        this.b1 * this.x1 +
        this.b2 * this.x2 -
        this.a1 * this.y1 -
        this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      this.count++;
      return y;
    }
  }
  class Processor {
    constructor() {
      this.notch = new Notch();
      this.reset("start");
    }
    reset(reason = "reset") {
      this.notch.reset();
      this.last = null;
      this.pendingReason = reason;
      this.segment = 0;
    }
    interrupt(reason = "interruption") {
      this.notch.reset();
      this.pendingReason = reason;
      this.segment++;
    }
    process(input) {
      const s = { ...input };
      let reason = this.pendingReason || s.resetHint || "";
      const deviceRestart =
        this.last &&
        s.ms < this.last.ms &&
        !(this.last.ms > 0xf0000000 && s.ms < 0x0fffffff);
      if (this.last) {
        if (s.source !== this.last.source) reason = "source-change";
        else if (s.restarted || deviceRestart) reason = "device-restart";
        else if (s.time - this.last.time !== 4) reason = "time-gap";
        else if (this.last.status !== 2 && s.status === 2)
          reason = "contact-restored";
      }
      if (s.status !== 2) reason = "invalid-contact";
      if (reason) {
        this.notch.reset();
        this.segment++;
      }
      s.filtered = s.status === 2 ? this.notch.next(s.adc) : null;
      s.warmup = s.status === 2 && this.notch.count <= FILTER.warmupSamples;
      s.saturated = s.adc === 0 || s.adc === 4095;
      s.resetReason = reason || "";
      s.segment = this.segment;
      this.pendingReason = "";
      this.last = s;
      return Object.freeze(s); // ADC and timestamps are never rewritten by the filter.
    }
  }
  // Only the live view evicts old records. A stopped recording never shares this array.
  class LiveBuffer {
    constructor() {
      this.items = [];
    }
    push(s) {
      this.items.push(s);
      while (
        this.items.length &&
        (this.items.length > 15000 || s.time - this.items[0].time > 60000)
      )
        this.items.shift();
    }
    clear() {
      this.items = [];
    }
  }
  class Recorder {
    constructor(now = () => performance.now()) {
      this.now = now;
      this.startedAt = 0;
      this.rows = [];
      this.active = false;
      this.source = null;
      this.reason = "尚未記錄";
    }
    start(source) {
      if (this.active || this.rows.length) return false;
      this.source = source;
      this.startedAt = this.now();
      this.active = true;
      this.reason = "記錄中";
      return true;
    }
    stop(reason = "手動停止") {
      if (this.active) {
        this.active = false;
        this.reason = reason;
      }
    }
    clear() {
      if (this.active) return false;
      this.rows = [];
      this.source = null;
      this.reason = "尚未記錄";
      return true;
    }
    tick() {
      if (this.active && this.now() - this.startedAt >= 300000)
        this.stop("達 5 分鐘上限，自動停止");
    }
    append(s) {
      this.tick();
      if (!this.active) return;
      if (s.source !== this.source) {
        this.stop("資料來源改變，自動停止");
        return;
      }
      // Include the sample at the 5-minute boundary, then stop without eviction.
      if (this.rows.length && s.time - this.rows[0].time > 300000) {
        this.stop("達 5 分鐘上限，自動停止");
        return;
      }
      this.rows.push(s);
      if (this.rows.length >= 75000) this.stop("達 75,000 筆上限，自動停止");
      else if (s.time - this.rows[0].time >= 300000)
        this.stop("達 5 分鐘上限，自動停止");
    }
  }
  function toCSV(rows) {
    const header =
      "time_ms,device_ms,adc,status,source,filtered_adc,filter_warmup,saturated,filter_reset,segment,filter_fs_hz,filter_center_hz,filter_q,filter_version";
    return (
      header +
      "\n" +
      rows
        .map((s) =>
          [
            s.time,
            s.ms,
            s.adc,
            s.status,
            s.source,
            s.filtered === null ? "" : s.filtered,
            s.warmup ? 1 : 0,
            s.saturated ? 1 : 0,
            s.resetReason,
            s.segment,
            FILTER.fs,
            FILTER.hz,
            FILTER.q,
            FILTER.version,
          ].join(","),
        )
        .join("\n")
    );
  }
  function parseCSV(text) {
    const lines = text
        .replace(/^\uFEFF/, "")
        .trim()
        .split(/\r?\n/),
      header = lines.shift().split(",");
    const required = ["time_ms", "device_ms", "adc", "status", "source"];
    if (required.some((k) => !header.includes(k)))
      throw new Error("CSV 缺少 time_ms,device_ms,adc,status,source 欄位");
    if (lines.length > 75000)
      throw new Error("CSV 超過 75,000 筆；未載入，沒有截斷資料");
    const rows = lines.map((line, i) => {
      const values = line.split(",");
      if (values.length !== header.length)
        throw new Error("第 " + (i + 2) + " 行欄位數不符");
      const get = (k) => values[header.indexOf(k)],
        numeric = (k) => (/^\d+$/.test(get(k)) ? Number(get(k)) : NaN);
      const s = {
        time: numeric("time_ms"),
        ms: numeric("device_ms"),
        adc: numeric("adc"),
        status: numeric("status"),
        source: get("source"),
      };
      if (
        ![s.time, s.ms, s.adc, s.status].every(Number.isSafeInteger) ||
        s.ms > 4294967295 ||
        s.adc > 4095 ||
        s.status > 2 ||
        !["usb", "demo"].includes(s.source)
      )
        throw new Error("第 " + (i + 2) + " 行數值或來源無效");
      const resets = [
        "start",
        "reset",
        "interruption",
        "source-change",
        "device-restart",
        "time-gap",
        "contact-restored",
        "invalid-contact",
        "transport-timeout",
        "disconnect",
        "demo-stop",
        "csv-import",
      ];
      if (
        header.includes("filter_reset") &&
        resets.includes(get("filter_reset"))
      )
        s.resetHint = get("filter_reset");
      return s;
    });
    if (!rows.length) throw new Error("CSV 沒有資料");
    if (rows.some((s) => s.source !== rows[0].source))
      throw new Error("CSV 混用資料來源；未載入");
    if (rows.some((s, i) => i && s.time < rows[i - 1].time))
      throw new Error("CSV 時間倒退；未載入，請檢查原始檔");
    return rows;
  }
  return { FILTER, Notch, Processor, LiveBuffer, Recorder, toCSV, parseCSV };
});
