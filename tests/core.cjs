const assert = require("node:assert/strict");
const ECG = require("../ecg-core.js");
const { Notch, Processor, Recorder, LiveBuffer, parseCSV, toCSV, FILTER } = ECG;
function amplitude(values, hz) {
  let re = 0,
    im = 0;
  for (let i = 0; i < values.length; i++) {
    const angle = (2 * Math.PI * hz * i) / FILTER.fs;
    re += values[i] * Math.cos(angle);
    im -= values[i] * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / values.length;
}
const notch = new Notch(),
  original = [],
  filtered = [];
for (let i = 0; i < 15000; i++) {
  const x =
    2000 +
    100 * Math.sin((2 * Math.PI * 10 * i) / 250) +
    100 * Math.sin((2 * Math.PI * 60 * i) / 250);
  const y = notch.next(x);
  if (i >= 1000) {
    original.push(x);
    filtered.push(y);
  }
}
const attenuation60 =
    20 * Math.log10(amplitude(filtered, 60) / amplitude(original, 60)),
  gain10 = 20 * Math.log10(amplitude(filtered, 10) / amplitude(original, 10));
assert.ok(attenuation60 < -80);
assert.ok(Math.abs(gain10) < 0.1);
assert.ok(
  Math.abs(filtered.reduce((a, b) => a + b, 0) / filtered.length - 2000) < 1e-6,
);
console.log(
  `Known 10+60 Hz signal: 60 Hz ${attenuation60.toFixed(2)} dB; 10 Hz ${gain10.toFixed(5)} dB; DC preserved`,
);
let p = new Processor();
const input = { time: 0, ms: 1000, adc: 4095, status: 2, source: "usb" };
let s = p.process(input);
assert.equal(input.adc, 4095);
assert.equal(s.adc, 4095);
assert.equal(s.saturated, true);
assert.equal(s.warmup, true);
for (let i = 1; i < 251; i++) s = p.process({ ...input, time: i * 4 });
assert.equal(s.warmup, false);
s = p.process({ ...input, time: 1020 });
assert.equal(s.resetReason, "time-gap");
assert.equal(s.warmup, true);
s = p.process({ ...input, time: 1024, status: 0 });
assert.equal(s.filtered, null);
s = p.process({ ...input, time: 1028 });
assert.equal(s.resetReason, "contact-restored");
assert.equal(s.warmup, true);
p.interrupt("transport-timeout");
s = p.process({ ...input, time: 1032 });
assert.equal(s.resetReason, "transport-timeout");
s = p.process({ ...input, time: 1036, restarted: true });
assert.equal(s.resetReason, "device-restart");
s = p.process({ ...input, time: 1040, source: "demo" });
assert.equal(s.resetReason, "source-change");
const r = new Recorder(),
  live = new LiveBuffer();
assert.equal(r.start("usb"), true);
for (let i = 0; i < 100; i++) {
  s = p.process({ ...input, time: i * 4, adc: i === 10 ? 0 : 4095 });
  r.append(s);
  live.push(s);
}
r.stop();
const saved = toCSV(r.rows);
for (let i = 100; i < 18000; i++) {
  s = p.process({ ...input, time: i * 4 });
  r.append(s);
  live.push(s);
}
assert.equal(toCSV(r.rows), saved);
assert.equal(r.rows.length, 100);
assert.equal(live.items.length, 15000);
assert.equal(r.start("demo"), false);
const parsed = parseCSV(saved);
assert.equal(parsed.length, 100);
assert.equal(parsed[10].adc, 0);
assert.equal(parsed[0].ms, 1000);
assert.ok(
  saved.includes("filter_fs_hz,filter_center_hz,filter_q,filter_version"),
);
assert.ok(saved.includes(",250,60,30,iirnotch-v1"));
r.clear();
r.start("usb");
for (let i = 0; i < 75001; i++) r.append({ ...input, time: i * 4 });
assert.equal(r.rows.length, 75000);
assert.equal(r.active, false);
assert.match(r.reason, /75,000/);
r.clear();
r.start("usb");
r.append({ ...input, time: 0 });
r.append({ ...input, time: 300000 });
assert.equal(r.active, false);
assert.match(r.reason, /5 分鐘/);
r.clear();
r.start("usb");
r.append(input);
r.append({ ...input, time: 4, source: "demo" });
assert.equal(r.rows.length, 1);
assert.equal(r.active, false);
assert.throws(
  () =>
    parseCSV(
      "time_ms,device_ms,adc,status,source\n0,0,2000,2,usb\n4,4,2000,2,demo",
    ),
  /混用/,
);
assert.throws(
  () => parseCSV("time_ms,device_ms,adc,status,source\n0,0,4096,2,usb"),
  /無效/,
);
let wall = 0;
const timed = new Recorder(() => wall);
timed.start("usb");
timed.append(input);
wall = 300000;
timed.tick();
assert.equal(timed.active, false);
assert.equal(timed.rows.length, 1);
// A normalized timeline can remain continuous while device_ms restarts.
const importedProcessor = new Processor();
importedProcessor.process({ ...input, time: 0, ms: 10000 });
assert.equal(
  importedProcessor.process({ ...input, time: 4, ms: 0 }).resetReason,
  "device-restart",
);
const hintRows = parseCSV(
  "time_ms,device_ms,adc,status,source,filter_reset\n0,1000,2000,2,usb,start\n4,1004,2000,2,usb,transport-timeout",
);
const hintProcessor = new Processor();
hintProcessor.process(hintRows[0]);
assert.equal(
  hintProcessor.process(hintRows[1]).resetReason,
  "transport-timeout",
);
const duplicate = parseCSV(
  "time_ms,device_ms,adc,status,source\n0,0,0,2,usb\n0,0,4095,2,usb",
);
const duplicateProcessor = new Processor();
const duplicates = duplicate.map((s) => duplicateProcessor.process(s));
assert.equal(duplicates.length, 2);
assert.equal(duplicates[1].resetReason, "time-gap");
console.log(
  "PASS: resets, 250-sample warmup, unchanged raw ADC, stopped recording immutable, 5-minute/75k caps, source isolation, CSV roundtrip, live buffer eviction",
);

// ---- Monitoring band (0.5–40 Hz + 60 Hz notch) ----
const { MonitorFilter, zeroPhase, MONITOR } = ECG;
function toneGain(hz) {
  const f = new MonitorFilter(),
    x = [],
    y = [];
  for (let i = 0; i < 20000; i++) {
    const v = 2000 + 300 * Math.sin((2 * Math.PI * hz * i) / MONITOR.fs);
    const out = f.next(v);
    if (i >= 5000) {
      x.push(v - 2000);
      y.push(out);
    }
  }
  return amplitude(y, hz) / amplitude(x, hz);
}
const g = {
  0.1: toneGain(0.1),
  1: toneGain(1),
  10: toneGain(10),
  40: toneGain(40),
  60: toneGain(60),
  100: toneGain(100),
};
assert.ok(g[0.1] < 0.05, "baseline wander removed");
assert.ok(g[1] > 0.95 && g[10] > 0.95 && g[10] < 1.01, "ECG band kept");
assert.ok(Math.abs(20 * Math.log10(g[40]) + 3.01) < 0.1, "-3 dB at 40 Hz");
assert.ok(g[60] < 1e-3 && g[100] < 0.05, "mains and HF removed");
console.log(
  "Monitor band gains: " +
    Object.entries(g)
      .map(([k, v]) => `${k} Hz ${(20 * Math.log10(v)).toFixed(2)} dB`)
      .join(", "),
);
// Constant input: no start-up step, output centred on 0.
const flat = new MonitorFilter();
for (let i = 0; i < 10; i++) assert.ok(Math.abs(flat.next(2048)) < 1e-9);
// Processor carries monitor channel, reset with notch, null when invalid.
const mp = new Processor();
let m = mp.process({ time: 0, ms: 0, adc: 2048, status: 2, source: "usb" });
assert.ok(Math.abs(m.monitor) < 1e-9);
m = mp.process({ time: 4, ms: 4, adc: 2048, status: 0, source: "usb" });
assert.equal(m.monitor, null);
// Zero-phase: a symmetric pulse stays symmetric about its peak (no phase lag).
const pulseRows = [];
const zp = new Processor();
for (let i = 0; i < 2500; i++) {
  const t = (i - 1250) / 250;
  pulseRows.push(
    zp.process({
      time: i * 4,
      ms: i * 4,
      adc: Math.round(2048 + 400 * Math.exp(-((t / 0.04) ** 2))),
      status: 2,
      source: "usb",
    }),
  );
}
const zrows = zeroPhase(pulseRows);
const peak = zrows.reduce((b, s, i) => (s.monitor > zrows[b].monitor ? i : b), 0);
const causalPeak = pulseRows.reduce(
  (b, s, i) => (s.monitor > pulseRows[b].monitor ? i : b),
  0,
);
assert.equal(peak, 1250, "zero-phase peak not shifted");
assert.ok(causalPeak > 1250, "causal filter delays the peak");
for (let k = 1; k < 40; k++)
  assert.ok(Math.abs(zrows[1250 - k].monitor - zrows[1250 + k].monitor) < 0.5);
assert.equal(Object.isFrozen(zrows[0]), true);
assert.equal(pulseRows[1250].zeroPhase, false);
assert.ok(toCSV(zrows).split("\n")[0].endsWith("monitor_adc,monitor_zero_phase,monitor_version"));
console.log(
  `PASS: monitor band, no start-up step, zero-phase peak at ${peak} (causal ${causalPeak}), CSV monitor columns`,
);
