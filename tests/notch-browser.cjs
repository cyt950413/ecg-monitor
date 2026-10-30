const { chromium } = require("playwright"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      let controller;
      window.mockPort = {
        readable: new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        async open() {},
        async close() {},
      };
      Object.defineProperty(navigator, "serial", {
        value: {
          async requestPort() {
            return mockPort;
          },
        },
      });
      window.send = (text) =>
        controller.enqueue(new TextEncoder().encode(text));
    });
    await page.route("https://localhost/**", (route) => {
      const js = new URL(route.request().url()).pathname.endsWith(
        "ecg-core.js",
      );
      return route.fulfill({
        path: path.resolve(js ? "ecg-core.js" : "index.html"),
        contentType: js ? "application/javascript" : "text/html",
      });
    });
    await page.goto("https://localhost/");
    await page.click("#connect");
    await page.click("#record-start");
    await page.evaluate(() => {
      send(
        Array.from(
          { length: 300 },
          (_, i) => `${i * 4},${i === 12 ? 4095 : 2000},2\n`,
        ).join(""),
      );
    });
    await page.waitForFunction(() => total === 300);
    assert.equal(await page.evaluate(() => recorder.rows.length), 300);
    assert.equal(await page.evaluate(() => samples[12].adc), 4095);
    assert.equal(await page.evaluate(() => samples[12].saturated), true);
    assert.equal(await page.evaluate(() => samples[249].warmup), true);
    assert.equal(await page.evaluate(() => samples[250].warmup), false);
    const countBefore = await page.evaluate(() => processor.notch.count);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => processor.notch.count), countBefore);
    await page.click("#pause");
    await page.evaluate(() => send("1200,2100,2\n"));
    await page.waitForFunction(() => total === 301);
    assert.equal(await page.evaluate(() => recorder.rows.length), 301);
    assert.equal(await page.evaluate(() => frozen.length), 300);
    await page.click("#record-stop");
    const saved = await page.evaluate(() => ECG.toCSV(recorder.rows));
    await page.evaluate(() => send("1220,0,2\n1224,1000,1\n1228,1900,2\n"));
    await page.waitForFunction(() => total === 304);
    assert.equal(
      await page.evaluate(() => samples[301].resetReason),
      "time-gap",
    );
    assert.equal(await page.evaluate(() => samples[301].warmup), true);
    assert.equal(await page.evaluate(() => samples[302].filtered), null);
    assert.equal(
      await page.evaluate(() => samples[303].resetReason),
      "contact-restored",
    );
    await page.click("#clear");
    assert.equal(await page.evaluate(() => samples.length), 0);
    assert.equal(await page.evaluate(() => ECG.toCSV(recorder.rows)), saved);
    const dl = page.waitForEvent("download");
    await page.click("#record-export");
    const download = await dl;
    const csv = fs.readFileSync(await download.path(), "utf8");
    assert.equal(csv, saved);
    assert.equal(csv.split("\n").length, 302);
    assert.ok(csv.includes("filter_q,filter_version"));
    assert.ok(csv.includes(",250,60,30,iirnotch-v1"));
    assert.equal(await page.locator("#record-start").isDisabled(), true);
    await page.click("#disconnect");
    await page.click("#demo");
    await page.waitForTimeout(100);
    await page.click("#demo");
    assert.equal(await page.evaluate(() => ECG.toCSV(recorder.rows)), saved);
    assert.equal(await page.evaluate(() => samples[0].source), "demo");
    // A local CSV is recomputed, never uploads, and does not overwrite the saved USB recording.
    const imported =
      "time_ms,device_ms,adc,status,source\n" +
      Array.from(
        { length: 400 },
        (_, i) => `${i * 4},${1000 + i * 4},${i === 1 ? 0 : 2000},2,usb`,
      ).join("\n");
    await page.setInputFiles("#csv-file", {
      name: "known.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(imported),
    });
    await page.waitForFunction(() => importedRows?.length === 400);
    assert.equal(await page.evaluate(() => importedRows[1].adc), 0);
    assert.equal(await page.evaluate(() => ECG.toCSV(recorder.rows)), saved);
    await page.selectOption("#view", "raw");
    await page.selectOption("#view", "filtered");
    await page.selectOption("#view", "compare");
    await page.locator("#history").fill("0.8");
    await page.locator("#history").dispatchEvent("input");
    assert.match(await page.locator("#history-label").innerText(), /0.8/);
    await page.setInputFiles("#csv-file", {
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("bad data"),
    });
    await page.waitForFunction(() =>
      document.getElementById("import-state").textContent.includes("失敗"),
    );
    assert.equal(await page.evaluate(() => importedRows.length), 400);
    page.once("dialog", (d) => d.accept());
    await page.click("#record-discard");
    assert.equal(await page.evaluate(() => recorder.rows.length), 0);
    // New connection clears imported view; a wall-clock interruption resets only the filter.
    await page.reload();
    await page.click("#connect");
    await page.evaluate(() => send("1000,2000,2\n"));
    await page.waitForTimeout(3200);
    assert.match(await page.locator("#filter-state").innerText(), /中斷/);
    await page.evaluate(() => send("1004,2100,2\n"));
    await page.waitForFunction(() => total === 2);
    assert.equal(
      await page.evaluate(() => samples[1].resetReason),
      "transport-timeout",
    );
    assert.equal(await page.evaluate(() => samples[1].warmup), true);
    await page.evaluate(() => send("4,2000,2\n"));
    await page.waitForFunction(() => total === 3);
    assert.equal(
      await page.evaluate(() => samples[2].resetReason),
      "device-restart",
    );
    await page.click("#disconnect");
    if (process.argv[2]) {
      await page.setInputFiles("#csv-file", process.argv[2]);
      await page.waitForFunction(() => importedRows !== null);
      assert.equal(await page.evaluate(() => importedRows.length), 14873);
      assert.equal(
        await page.evaluate(
          () =>
            importedRows.filter((s) => s.status === 2 && s.adc === 0).length,
        ),
        271,
      );
      await page.setViewportSize({ width: 1200, height: 1000 });
      await page.screenshot({
        path: "/tmp/ecg-comparison-desktop.png",
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: "/tmp/ecg-comparison-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: sample-driven notch, warmup, raw saturation, pause vs recording, immutable stop, CSV metadata, source isolation, local import, timeline, invalid file atomicity, interruption/restart resets, mobile layout",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
