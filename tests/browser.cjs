const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    let controller;
    window.testSerial = { cancel: false, closed: 0, openOptions: null };
    const port = {
      readable: new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          window.testSerial.cancel = true;
        },
      }),
      async open(options) {
        window.testSerial.openOptions = options;
      },
      async close() {
        window.testSerial.closed++;
      },
    };
    Object.defineProperty(navigator, "serial", {
      value: {
        async requestPort() {
          return port;
        },
      },
    });
    window.send = (chunk) =>
      controller.enqueue(new TextEncoder().encode(chunk));
    window.end = () => controller.close();
  });
  await page.route("https://localhost/**", (route) =>
    route.fulfill({
      path: path.resolve(
        new URL(route.request().url()).pathname.endsWith("ecg-core.js")
          ? "ecg-core.js"
          : "index.html",
      ),
      contentType: new URL(route.request().url()).pathname.endsWith(".js")
        ? "application/javascript"
        : "text/html",
    }),
  );
  await page.goto("https://localhost/");
  await page.click("#connect");
  await page.evaluate(() => send("100,2000,1\r\n104,20"));
  await page.evaluate(() => send("48,2\ninvalid\n108,9999,2\n112,2100,2\n"));
  assert.equal(await page.locator("#count").innerText(), "3");
  assert.equal(await page.locator("#contact").innerText(), "接觸正常");
  assert.equal(
    await page.evaluate(() => testSerial.openOptions.baudRate),
    115200,
  );
  await page.click("#pause");
  await page.evaluate(() => send("116,2200,2\n"));
  assert.equal(await page.evaluate(() => frozen.length), 3);
  assert.equal(await page.evaluate(() => samples.length), 4);
  await page.evaluate(() => send("120,0,0\n"));
  assert.equal(await page.locator("#contact").innerText(), "電極脫落");
  await page.evaluate(() => send("x".repeat(500) + "\n124,1800,2\n"));
  assert.equal(await page.evaluate(() => samples.length), 6);
  const downloadPromise = page.waitForEvent("download");
  await page.click("#export");
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^ecg-usb-/);
  await page.click("#disconnect");
  assert.equal(await page.evaluate(() => testSerial.closed), 1);
  assert.equal(await page.evaluate(() => testSerial.cancel), true);
  await page.click("#pause");
  await page.click("#demo");
  await page.waitForTimeout(150);
  assert.ok((await page.evaluate(() => samples.length)) > 0);
  assert.equal(await page.evaluate(() => samples[0].source), "demo");
  await page.click("#demo");
  await page.click("#clear");
  assert.equal(await page.evaluate(() => samples.length), 0);
  await page.evaluate(() => {
    reset();
    mode = "usb";
    accept({ ms: 4294967292, adc: 10, status: 2 });
    accept({ ms: 0, adc: 20, status: 2 });
    accept({ ms: 4, adc: 30, status: 2 });
  });
  assert.deepEqual(
    await page.evaluate(() => samples.map((s) => s.time)),
    [0, 4, 8],
  );
  await page.evaluate(() => {
    reset();
    for (let i = 0; i < 16000; i++) accept({ ms: i * 4, adc: 2000, status: 2 });
  });
  assert.equal(await page.evaluate(() => samples.length), 15000);
  await page.evaluate(() => {
    reset();
    accept({ ms: 1000, adc: 1000, status: 2 });
    accept({ ms: 4, adc: 1000, status: 1 });
    accept({ ms: 8, adc: 1000, status: 2 });
  });
  assert.deepEqual(
    await page.evaluate(() => samples.map((s) => s.time)),
    [0, 4, 8],
  );
  await page.reload();
  await page.click("#connect");
  await page.evaluate(() => end());
  await page.waitForFunction(
    () => document.getElementById("connect").disabled === false,
  );
  assert.equal(await page.evaluate(() => testSerial.closed), 1);
  assert.match(await page.locator("#message").innerText(), /中斷/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "/tmp/ecg-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  const unsupported = await browser.newPage();
  await unsupported.addInitScript(() =>
    Object.defineProperty(navigator, "serial", { value: undefined }),
  );

  await unsupported.route("https://localhost/**", (route) =>
    route.fulfill({
      path: path.resolve(
        new URL(route.request().url()).pathname.endsWith("ecg-core.js")
          ? "ecg-core.js"
          : "index.html",
      ),
      contentType: new URL(route.request().url()).pathname.endsWith(".js")
        ? "application/javascript"
        : "text/html",
    }),
  );
  await unsupported.goto("https://localhost/");
  assert.equal(await unsupported.locator("#connect").isDisabled(), true);
  console.log(
    "PASS: fragmented CSV, invalid records, status, pause, export, disconnect cleanup, demo isolation, clear, timer wrap, bounded buffer, mobile layout, no JS errors",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
