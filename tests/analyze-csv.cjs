// Reproducible paired Welch PSD, using exactly the same steady-state samples.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { Processor, parseCSV, FILTER } = require("../ecg-core.js");
if (!process.argv[2]) {
  console.error(
    "Usage: node tests/analyze-csv.cjs input.csv [output-directory]",
  );
  process.exit(1);
}
const file = fs.readFileSync(process.argv[2]),
  rows = parseCSV(file.toString("utf8")),
  processor = new Processor(),
  samples = rows.map((s) => processor.process(s));
const n = 1024,
  hop = 512,
  window = Array.from(
    { length: n },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)),
  ),
  windowPower = window.reduce((s, x) => s + x * x, 0);
const rawPSD = Array(n / 2 + 1).fill(0),
  filteredPSD = rawPSD.slice();
let windows = 0;
let run = [];
const runs = [];
for (const s of samples) {
  if (s.status !== 2 || s.warmup || s.filtered === null) {
    if (run.length) runs.push(run);
    run = [];
    continue;
  }
  if (
    run.length &&
    (s.segment !== run[run.length - 1].segment ||
      s.time - run[run.length - 1].time !== 4)
  ) {
    runs.push(run);
    run = [];
  }
  run.push(s);
}
if (run.length) runs.push(run);
for (const segment of runs) {
  for (let start = 0; start + n <= segment.length; start += hop) {
    const block = segment.slice(start, start + n),
      rawMean = block.reduce((s, x) => s + x.adc, 0) / n,
      filteredMean = block.reduce((s, x) => s + x.filtered, 0) / n;
    for (let k = 0; k <= n / 2; k++) {
      let rr = 0,
        ri = 0,
        fr = 0,
        fi = 0;
      for (let i = 0; i < n; i++) {
        const theta = (2 * Math.PI * k * i) / n,
          c = Math.cos(theta),
          s = Math.sin(theta),
          r = (block[i].adc - rawMean) * window[i],
          f = (block[i].filtered - filteredMean) * window[i];
        rr += r * c;
        ri -= r * s;
        fr += f * c;
        fi -= f * s;
      }
      const scale =
        (k === 0 || k === n / 2 ? 1 : 2) / (FILTER.fs * windowPower);
      rawPSD[k] += (rr * rr + ri * ri) * scale;
      filteredPSD[k] += (fr * fr + fi * fi) * scale;
    }
    windows++;
  }
}
if (!windows)
  throw new Error(
    "No continuous steady-state runs long enough for 1024-sample Welch windows",
  );
for (let k = 0; k < rawPSD.length; k++) {
  rawPSD[k] /= windows;
  filteredPSD[k] /= windows;
}
const df = FILTER.fs / n;
function band(psd, low, high) {
  return psd.reduce(
    (sum, p, k) => sum + (k * df >= low && k * df <= high ? p * df : 0),
    0,
  );
}
const bandRaw = band(rawPSD, 58, 62),
  bandFiltered = band(filteredPSD, 58, 62);
const peak = Array.from({ length: rawPSD.length }, (_, k) => k)
  .filter((k) => k * df >= 58 && k * df <= 62)
  .reduce((a, b) => (rawPSD[a] > rawPSD[b] ? a : b));
const intervals = {};
for (let i = 1; i < rows.length; i++) {
  const dt = rows[i].time - rows[i - 1].time;
  intervals[dt] = (intervals[dt] || 0) + 1;
}
const normal = rows.filter((s) => s.status === 2),
  stats = {
    sha256: crypto.createHash("sha256").update(file).digest("hex"),
    rows: rows.length,
    durationSeconds: (rows.at(-1).time - rows[0].time) / 1000,
    averageHz: ((rows.length - 1) * 1000) / (rows.at(-1).time - rows[0].time),
    states: Object.fromEntries(
      [0, 1, 2].map((status) => [
        status,
        rows.filter((s) => s.status === status).length,
      ]),
    ),
    intervalsMs: intervals,
    normalADC0: normal.filter((s) => s.adc === 0).length,
    normalADC4095: normal.filter((s) => s.adc === 4095).length,
    rawPreserved: samples.every(
      (s, i) =>
        s.adc === rows[i].adc && s.time === rows[i].time && s.ms === rows[i].ms,
    ),
    filter: FILTER,
    welch: {
      window: "Hann symmetric, per-window mean removed",
      n,
      hop,
      windows,
      dfHz: df,
      excluded:
        "status != 2, first 250 samples after every reset, windows crossing gaps",
      peakHz: peak * df,
      rawBand58to62ADC2: bandRaw,
      filteredBand58to62ADC2: bandFiltered,
      powerRatioDb: 10 * Math.log10(bandFiltered / bandRaw),
      rawBand5to40ADC2: band(rawPSD, 5, 40),
      filteredBand5to40ADC2: band(filteredPSD, 5, 40),
    },
  };
const out = process.argv[3] || "/tmp/ecg-analysis";
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(out, "csv-analysis.json"),
  JSON.stringify(stats, null, 2) + "\n",
);
const W = 960,
  H = 440,
  left = 70,
  right = 930,
  top = 45,
  bottom = 375;
const inRange = rawPSD.filter((_, k) => k * df >= 1 && k * df <= 100),
  maxDB =
    Math.ceil(
      Math.max(...inRange.map((x) => 10 * Math.log10(Math.max(x, 1e-12)))) / 10,
    ) * 10,
  minDB = maxDB - 80;
const px = (f) => left + (f / 100) * (right - left),
  py = (db) => bottom - ((db - minDB) / (maxDB - minDB)) * (bottom - top);
function line(psd) {
  return psd
    .map((p, k) => [k * df, 10 * Math.log10(Math.max(p, 1e-12))])
    .filter(([f]) => f <= 100)
    .map(
      ([f, db], i) =>
        (i ? "L" : "M") +
        px(f).toFixed(2) +
        "," +
        py(Math.max(minDB, Math.min(maxDB, db))).toFixed(2),
    )
    .join(" ");
}
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="440" viewBox="0 0 960 440"><rect width="100%" height="100%" fill="#fff"/><g font-family="sans-serif" font-size="13" fill="#243047"><text x="70" y="23">Paired Welch PSD · Fs=250 Hz · 60 Hz notch Q=30 · ${windows} windows · 58–62 Hz: ${stats.welch.powerRatioDb.toFixed(2)} dB</text>`;
for (let f = 0; f <= 100; f += 10)
  svg += `<path d="M${px(f)},${top}V${bottom}" stroke="#ddd"/><text x="${px(f) - 8}" y="397">${f}</text>`;
for (let db = minDB; db <= maxDB; db += 10)
  svg += `<path d="M${left},${py(db)}H${right}" stroke="#ddd"/><text x="10" y="${py(db) + 4}">${db}</text>`;
svg += `<path d="${line(rawPSD)}" fill="none" stroke="#16865e" stroke-width="1.6"/><path d="${line(filteredPSD)}" fill="none" stroke="#246bdb" stroke-width="1.6"/><text x="700" y="55" fill="#16865e">Raw ADC</text><text x="800" y="55" fill="#246bdb">Filtered ADC</text><text x="430" y="425">Frequency (Hz)</text><text x="8" y="35">dB ADC²/Hz</text></g></svg>`;
fs.writeFileSync(path.join(out, "csv-spectrum.svg"), svg);
console.log(JSON.stringify(stats, null, 2));
