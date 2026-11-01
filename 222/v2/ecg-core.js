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
  // Monitoring-mode ECG band (IEC 60601-2-27 style): 0.5 Hz high-pass removes
  // baseline wander, 40 Hz low-pass removes EMG / residual high-frequency noise,
  // 60 Hz notch removes mains. Same coefficients as the ESP32 TFT firmware and
  // scipy.signal.butter(2, fc, fs=250) / iirnotch(60, 30, fs=250).
  const MONITOR = Object.freeze({
    fs: 250,
    highpassHz: 0.5,
    lowpassHz: 40,
    notchHz: 60,
    notchQ: 30,
    version: "monitor-0.5-40-v1",
  });
  class Biquad {
    constructor(b0, b1, b2, a1, a2) {
      Object.assign(this, { b0, b1, b2, a1, a2 });
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    // Steady state for a constant input x (avoids a fictitious start-up step).
    prime(x) {
      const y =
        (x * (this.b0 + this.b1 + this.b2)) / (1 + this.a1 + this.a2);
      this.x1 = this.x2 = x;
      this.y1 = this.y2 = y;
      return y;
    }
    next(x) {
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
      return y;
    }
  }
  function butter2(type, fc, fs) {
    const w = (2 * Math.PI * fc) / fs,
      c = Math.cos(w),
      alpha = Math.sin(w) / Math.SQRT2, // Q = 1/sqrt(2)
      a0 = 1 + alpha,
      k = type === "low" ? (1 - c) / 2 : (1 + c) / 2;
    return new Biquad(
      k / a0,
      (type === "low" ? 2 * k : -2 * k) / a0,
      k / a0,
      (-2 * c) / a0,
      (1 - alpha) / a0,
    );
  }
  function notch2(f0, q, fs) {
    const w = (2 * Math.PI * f0) / fs,
      alpha = Math.tan(w / (2 * q)),
      b0 = 1 / (1 + alpha),
      b1 = (-2 * Math.cos(w)) / (1 + alpha);
    return new Biquad(b0, b1, b0, b1, (1 - alpha) / (1 + alpha));
  }
  // Output is centred on 0 (ADC counts relative to baseline).
  class MonitorFilter {
    constructor() {
      this.reset();
    }
    reset() {
      this.stages = [
        butter2("high", MONITOR.highpassHz, MONITOR.fs),
        notch2(MONITOR.notchHz, MONITOR.notchQ, MONITOR.fs),
        butter2("low", MONITOR.lowpassHz, MONITOR.fs),
      ];
      this.count = 0;
    }
    next(x) {
      if (!this.count) {
        let v = x;
        for (const stage of this.stages) v = stage.prime(v);
      }
      this.count++;
      let y = x;
      for (const stage of this.stages) y = stage.next(y);
      return y;
    }
  }
  // Forward-backward (filtfilt-style) pass for stored data: zero phase, so
  // P/QRS/T shapes and timing are not distorted by the causal filter.
  // Runs separately inside every continuous valid segment; never crosses gaps.
  function zeroPhase(rows) {
    const out = rows.map((s) => ({ ...s, monitor: null, zeroPhase: false }));
    let i = 0;
    while (i < rows.length) {
      if (rows[i].status !== 2) {
        i++;
        continue;
      }
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j].status === 2 &&
        rows[j].segment === rows[i].segment
      )
        j++;
      const forward = new MonitorFilter(),
        backward = new MonitorFilter(),
        y = [];
      for (let k = i; k < j; k++) y.push(forward.next(rows[k].adc));
      for (let k = y.length - 1; k >= 0; k--) y[k] = backward.next(y[k]);
      for (let k = i; k < j; k++) {
        out[k].monitor = y[k - i];
        out[k].zeroPhase = true;
      }
      i = j;
    }
    return out.map((s) => Object.freeze(s));
  }
  class Processor {
    constructor() {
      this.notch = new Notch();
      this.monitor = new MonitorFilter();
      this.reset("start");
    }
    reset(reason = "reset") {
      this.notch.reset();
      this.monitor.reset();
      this.last = null;
      this.pendingReason = reason;
      this.segment = 0;
    }
    interrupt(reason = "interruption") {
      this.notch.reset();
      this.monitor.reset();
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
        this.monitor.reset();
        this.segment++;
      }
      s.filtered = s.status === 2 ? this.notch.next(s.adc) : null;
      s.monitor = s.status === 2 ? this.monitor.next(s.adc) : null;
      s.zeroPhase = false;
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
      "time_ms,device_ms,adc,status,source,filtered_adc,filter_warmup,saturated,filter_reset,segment,filter_fs_hz,filter_center_hz,filter_q,filter_version,monitor_adc,monitor_zero_phase,monitor_version";
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
            s.monitor === null || s.monitor === undefined ? "" : s.monitor,
            s.zeroPhase ? 1 : 0,
            MONITOR.version,
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
  return {
    FILTER,
    MONITOR,
    Notch,
    Biquad,
    butter2,
    notch2,
    MonitorFilter,
    zeroPhase,
    Processor,
    LiveBuffer,
    Recorder,
    toCSV,
    parseCSV,
  };
});
