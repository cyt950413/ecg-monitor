#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <atomic>
#include <math.h>

// 注意：結構要放在最前面。Arduino IDE 會自動在第一個函式前插入函式宣告，
// 若結構定義在那之後，就會出現「'OutSample' does not name a type」。
// 取樣端 → 輸出端傳遞的一筆 250 Hz 資料。
struct OutSample {
  uint32_t ms;
  uint16_t adc;
  uint8_t status;
};

// =====================================================================
// ESP32 + AD8232 心電：1 kHz 取樣 → 平均降頻 250 Hz → USB 輸出 + TFT 顯示
//
// 與上一版的差別：
//  1. 取樣改由獨立 FreeRTOS 工作（core 0）每 1 ms 執行，TFT 繪圖不會再拖慢或
//     打亂取樣時間。每 1 ms 連讀 ADC 4 次平均，再把 4 個 1 ms 結果平均成一筆
//     250 Hz 輸出（共 16 次讀值）。4 點平均在 250、500 Hz 有零點，能壓低
//     會「混疊」回 0–40 Hz 的高頻雜訊，也降低 ESP32 ADC 自身雜訊。
//  2. 只要 4 ms 內任何一次讀值碰到 0 或 4095，輸出就保留 0/4095，
//     網頁仍能標示「可能飽和」，不會被平均藏起來。
//  3. USB 格式完全不變：timestamp_ms,raw_adc,status，間隔固定 4 ms。
//  4. TFT 改畫「監護濾波」波形：0.5 Hz 高通 + 60 Hz notch + 40 Hz 低通，
//     換算成 mV，固定比例 25 mm/s、20 mm/mV（心電圖機的 ×2 增益檔）。
// =====================================================================

// ===== 螢幕接腳：沿用原本成功的接線 =====
constexpr int TFT_CS   = 27;
constexpr int TFT_DC   = 25;
constexpr int TFT_RST  = 26;
constexpr int TFT_SCK  = 18;
constexpr int TFT_MOSI = 23;

// ===== AD8232 接腳 =====
constexpr int ECG_PIN      = 34;
constexpr int LO_PLUS_PIN  = 13;
constexpr int LO_MINUS_PIN = 14;

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// ===== 取樣設定 =====
constexpr int ADC_BURST = 4;      // 每 1 ms 連讀次數
constexpr int DECIMATE  = 4;      // 每 4 個 1 ms 合成一筆 → 250 Hz
constexpr double OUTPUT_FS = 250.0;

// ===== 類比換算（請依你的模組修改）=====
// SparkFun 型 AD8232 模組總增益約 1100 倍（1 mV 心電 → 約 1.1 V）。
// 若在 AD8232 OUTPUT 與 GPIO34 之間加 1:2 分壓（例如 10k/10k），
// 把 DIVIDER_RATIO 改成 0.5；網頁的「增益」欄位也要填 550。
constexpr double AD8232_GAIN       = 1100.0;
constexpr double DIVIDER_RATIO     = 1.0;
constexpr double ADC_FULL_SCALE_MV = 3300.0;  // 近似值；ESP32 ADC 本身非線性
constexpr double COUNTS_PER_MV =
  AD8232_GAIN * DIVIDER_RATIO * 4095.0 / ADC_FULL_SCALE_MV;

// ===== 波形顯示區 =====
constexpr int GRAPH_LEFT   = 10;
constexpr int GRAPH_RIGHT  = 309;
constexpr int GRAPH_TOP    = 65;
constexpr int GRAPH_BOTTOM = 219;

// 每 5 筆（20 ms）畫一欄 → 50 欄/秒。把 2 px 當 1 mm：50 px/s = 25 mm/s。
// 20 mm/mV = 40 px/mV。0 mV 基線放在偏下方，可顯示約 −1.3 ~ +2.5 mV。
constexpr int SAMPLES_PER_COLUMN = 5;
constexpr double TFT_PX_PER_MV = 40.0;
constexpr int BASELINE_Y = GRAPH_BOTTOM - 54;
constexpr int GRID_STEP = 10;     // 10 px = 5 mm 大格（0.2 s / 0.25 mV）

constexpr uint16_t GRID_COLOR  = 0x2104;
constexpr uint16_t GRID_MAJOR  = 0x4208;

// 狀態代碼
constexpr int STATUS_OFF  = 0;
constexpr int STATUS_WAIT = 1;
constexpr int STATUS_RUN  = 2;

// ---------------------------------------------------------------------
// 二階 IIR（Direct Form I，double 精度）。係數與網頁 ecg-core.js、
// scipy.signal.butter(2, …) / iirnotch 相同。
// ---------------------------------------------------------------------
struct Biquad {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  double process(double x) {
    double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    return y;
  }

  // 以「輸入一直是 x」的穩態初始化，避免開頭出現假的大跳動。
  double prime(double x) {
    double dcGain = (b0 + b1 + b2) / (1.0 + a1 + a2);
    double y = x * dcGain;
    x1 = x2 = x;
    y1 = y2 = y;
    return y;
  }
};

Biquad makeLowpass(double fc, double fs) {
  const double w = 2.0 * M_PI * fc / fs, c = cos(w);
  const double alpha = sin(w) / (2.0 * M_SQRT1_2), a0 = 1.0 + alpha;
  Biquad f;
  f.b0 = (1.0 - c) / 2.0 / a0;
  f.b1 = (1.0 - c) / a0;
  f.b2 = f.b0;
  f.a1 = -2.0 * c / a0;
  f.a2 = (1.0 - alpha) / a0;
  return f;
}

Biquad makeHighpass(double fc, double fs) {
  const double w = 2.0 * M_PI * fc / fs, c = cos(w);
  const double alpha = sin(w) / (2.0 * M_SQRT1_2), a0 = 1.0 + alpha;
  Biquad f;
  f.b0 = (1.0 + c) / 2.0 / a0;
  f.b1 = -(1.0 + c) / a0;
  f.b2 = f.b0;
  f.a1 = -2.0 * c / a0;
  f.a2 = (1.0 - alpha) / a0;
  return f;
}

Biquad makeNotch(double f0, double q, double fs) {
  const double w = 2.0 * M_PI * f0 / fs, alpha = tan(w / (2.0 * q));
  Biquad f;
  f.b0 = 1.0 / (1.0 + alpha);
  f.b1 = -2.0 * cos(w) / (1.0 + alpha);
  f.b2 = f.b0;
  f.a1 = f.b1;
  f.a2 = (1.0 - alpha) / (1.0 + alpha);
  return f;
}

// 監護頻寬：0.5 Hz 高通（去基線漂移）→ 60 Hz notch → 40 Hz 低通（去肌電/殘餘雜訊）
struct MonitorFilter {
  Biquad hp = makeHighpass(0.5, OUTPUT_FS);
  Biquad notch = makeNotch(60.0, 30.0, OUTPUT_FS);
  Biquad lp = makeLowpass(40.0, OUTPUT_FS);
  bool primed = false;

  void reset() { primed = false; }

  double process(double x) {
    if (!primed) {
      lp.prime(notch.prime(hp.prime(x)));
      primed = true;
    }
    return lp.process(notch.process(hp.process(x)));
  }
};

MonitorFilter monitorFilter;

// ---------------------------------------------------------------------
// 取樣端（core 0）→ 輸出端（core 1）之間的單生產者/單消費者環形緩衝
// ---------------------------------------------------------------------
constexpr uint32_t RING_SIZE = 512;  // 2 的次方；約 2 秒緩衝
OutSample ring[RING_SIZE];
std::atomic<uint32_t> ringHead{0};
std::atomic<uint32_t> ringTail{0};
volatile uint32_t droppedSamples = 0;

bool ringPush(const OutSample& s) {
  uint32_t head = ringHead.load(std::memory_order_relaxed);
  if (head - ringTail.load(std::memory_order_acquire) >= RING_SIZE) {
    droppedSamples = droppedSamples + 1;
    return false;
  }
  ring[head & (RING_SIZE - 1)] = s;
  ringHead.store(head + 1, std::memory_order_release);
  return true;
}

bool ringPop(OutSample& s) {
  uint32_t tail = ringTail.load(std::memory_order_relaxed);
  if (tail == ringHead.load(std::memory_order_acquire)) {
    return false;
  }
  s = ring[tail & (RING_SIZE - 1)];
  ringTail.store(tail + 1, std::memory_order_release);
  return true;
}

// ---------------------------------------------------------------------
// 取樣端狀態（只在取樣工作中使用）
// ---------------------------------------------------------------------
int tickPhase = 0;
uint32_t accSum = 0;
bool accHigh = false;
bool accLow = false;
bool accOff = false;
bool contactActive = false;
uint32_t contactStartMs = 0;

// 每 1 ms 呼叫一次。nowMs 由 FreeRTOS tick 決定，輸出時間戳一定剛好相差 4 ms。
void samplerTick(uint32_t nowMs) {
  bool off =
    digitalRead(LO_PLUS_PIN) == HIGH ||
    digitalRead(LO_MINUS_PIN) == HIGH;

  if (off) {
    accOff = true;
  } else {
    for (int i = 0; i < ADC_BURST; i++) {
      int v = analogRead(ECG_PIN);
      accSum += (uint32_t)v;
      if (v >= 4095) accHigh = true;
      if (v <= 0) accLow = true;
    }
  }

  if (++tickPhase < DECIMATE) {
    return;
  }
  tickPhase = 0;

  OutSample s;
  s.ms = nowMs;

  if (accOff) {
    contactActive = false;
    s.adc = 0;
    s.status = STATUS_OFF;
  } else {
    if (!contactActive) {
      contactActive = true;
      contactStartMs = nowMs;
    }
    constexpr uint32_t N = ADC_BURST * DECIMATE;
    uint32_t avg = (accSum + N / 2) / N;
    if (accHigh) avg = 4095;       // 飽和要讓網頁看得到，不被平均掉
    else if (accLow) avg = 0;
    s.adc = (uint16_t)avg;
    // 重新接觸後等待 3 秒。
    s.status = (nowMs - contactStartMs < 3000) ? STATUS_WAIT : STATUS_RUN;
  }

  accSum = 0;
  accHigh = accLow = accOff = false;
  ringPush(s);
}

#if defined(ESP32)
#if configTICK_RATE_HZ != 1000
#error "This sketch expects FreeRTOS tick = 1 ms (Arduino-ESP32 default)."
#endif
void samplerTask(void*) {
  TickType_t lastWake = xTaskGetTickCount();
  for (;;) {
    vTaskDelayUntil(&lastWake, 1);
    samplerTick((uint32_t)lastWake);
  }
}
#endif

// ---------------------------------------------------------------------
// 輸出端狀態（loop() / core 1）
// ---------------------------------------------------------------------
int graphX = GRAPH_LEFT;
int previousY = 0;
bool previousPointValid = false;

int bucketCount = 0;
double bucketMin = 0;
double bucketMax = 0;

int displayedStatus = -1;
bool clipShown = false;
uint32_t lastClipMs = 0;
bool clipSeen = false;

void resetBucket() {
  bucketCount = 0;
  bucketMin = 1e9;
  bucketMax = -1e9;
}

// mV → 畫面 y。超出範圍就貼齊上下邊。
int mvToY(double mv) {
  int y = BASELINE_Y - (int)lround(mv * TFT_PX_PER_MV);
  return constrain(y, GRAPH_TOP, GRAPH_BOTTOM);
}

bool isMajorRow(int y) {
  return ((y - BASELINE_Y) % (GRID_STEP * 5)) == 0;
}

void drawGraphBackground() {
  tft.fillRect(
    GRAPH_LEFT, GRAPH_TOP,
    GRAPH_RIGHT - GRAPH_LEFT + 1,
    GRAPH_BOTTOM - GRAPH_TOP + 1,
    ILI9341_BLACK
  );

  for (int x = GRAPH_LEFT; x <= GRAPH_RIGHT; x += GRID_STEP) {
    bool major = ((x - GRAPH_LEFT) % (GRID_STEP * 5)) == 0;  // 1 秒
    tft.drawFastVLine(x, GRAPH_TOP, GRAPH_BOTTOM - GRAPH_TOP + 1,
                      major ? GRID_MAJOR : GRID_COLOR);
  }

  for (int y = BASELINE_Y; y >= GRAPH_TOP; y -= GRID_STEP) {
    tft.drawFastHLine(GRAPH_LEFT, y, GRAPH_RIGHT - GRAPH_LEFT + 1,
                      isMajorRow(y) ? GRID_MAJOR : GRID_COLOR);
  }
  for (int y = BASELINE_Y + GRID_STEP; y <= GRAPH_BOTTOM; y += GRID_STEP) {
    tft.drawFastHLine(GRAPH_LEFT, y, GRAPH_RIGHT - GRAPH_LEFT + 1,
                      isMajorRow(y) ? GRID_MAJOR : GRID_COLOR);
  }

  tft.drawRect(
    GRAPH_LEFT - 1, GRAPH_TOP - 1,
    GRAPH_RIGHT - GRAPH_LEFT + 3,
    GRAPH_BOTTOM - GRAPH_TOP + 3,
    ILI9341_WHITE
  );
}

// 擦除一欄舊波形，同時補回格線。
void clearColumn(int x) {
  if ((x - GRAPH_LEFT) % GRID_STEP == 0) {
    bool major = ((x - GRAPH_LEFT) % (GRID_STEP * 5)) == 0;
    tft.drawFastVLine(x, GRAPH_TOP, GRAPH_BOTTOM - GRAPH_TOP + 1,
                      major ? GRID_MAJOR : GRID_COLOR);
    return;
  }

  tft.drawFastVLine(x, GRAPH_TOP, GRAPH_BOTTOM - GRAPH_TOP + 1, ILI9341_BLACK);
  for (int y = BASELINE_Y; y >= GRAPH_TOP; y -= GRID_STEP) {
    tft.drawPixel(x, y, isMajorRow(y) ? GRID_MAJOR : GRID_COLOR);
  }
  for (int y = BASELINE_Y + GRID_STEP; y <= GRAPH_BOTTOM; y += GRID_STEP) {
    tft.drawPixel(x, y, isMajorRow(y) ? GRID_MAJOR : GRID_COLOR);
  }
}

void showStatus(int status) {
  if (status == displayedStatus) {
    return;
  }

  displayedStatus = status;
  clipShown = false;

  tft.fillRect(0, 27, 320, 29, ILI9341_BLACK);
  tft.setCursor(10, 32);
  tft.setTextSize(2);

  if (status == STATUS_OFF) {
    tft.setTextColor(ILI9341_RED);
    tft.print("LEADS OFF");
  } else if (status == STATUS_WAIT) {
    tft.setTextColor(ILI9341_YELLOW);
    tft.print("WAIT: KEEP STILL");
  } else {
    tft.setTextColor(ILI9341_GREEN);
    tft.print("CONTACT OK");
  }
}

// 最近 2 秒內有 ADC 撞到 0/4095 時，在右上角顯示 CLIP。
void showClip(bool clipping) {
  if (clipping == clipShown) {
    return;
  }
  clipShown = clipping;
  tft.fillRect(230, 27, 90, 29, ILI9341_BLACK);
  if (clipping) {
    tft.setCursor(240, 32);
    tft.setTextSize(2);
    tft.setTextColor(ILI9341_RED);
    tft.print("CLIP!");
  }
}

void drawWaveColumn(double lastMv) {
  clearColumn(graphX);

  int lastY = mvToY(lastMv);
  int topY = mvToY(bucketMax);
  int bottomY = mvToY(bucketMin);

  if (previousPointValid && graphX > GRAPH_LEFT) {
    tft.drawLine(graphX - 1, previousY, graphX, lastY, ILI9341_GREEN);
  }

  tft.drawFastVLine(graphX, topY, bottomY - topY + 1, ILI9341_GREEN);

  previousY = lastY;
  previousPointValid = true;

  graphX++;

  if (graphX > GRAPH_RIGHT) {
    graphX = GRAPH_LEFT;
    previousPointValid = false;
  }
}

// CSV: timestamp_ms,raw_adc,status (0=off, 1=settling, 2=ready).
// Skip a complete record if USB TX is full; never block TFT waiting for a host.
void sendSample(uint32_t timestampMs, int rawValue, int status) {
  char line[40];
  int length = snprintf(line, sizeof(line), "%lu,%d,%d\n",
                        (unsigned long)timestampMs, rawValue, status);
  if (length > 0 && length < (int)sizeof(line) &&
      Serial.availableForWrite() >= length) {
    Serial.write((const uint8_t*)line, length);
  }
}

void handleOutput(const OutSample& s) {
  sendSample(s.ms, s.adc, s.status);

  if (s.status == STATUS_OFF) {
    monitorFilter.reset();
    previousPointValid = false;
    resetBucket();
    showStatus(STATUS_OFF);
    return;
  }

  if (s.adc == 0 || s.adc == 4095) {
    lastClipMs = s.ms;
    clipSeen = true;
  }

  // 等待期間濾波器照樣運作（暖機），但不畫圖。
  double mv = monitorFilter.process((double)s.adc) / COUNTS_PER_MV;

  if (s.status == STATUS_WAIT) {
    previousPointValid = false;
    resetBucket();
    showStatus(STATUS_WAIT);
    return;
  }

  showStatus(STATUS_RUN);
  showClip(clipSeen && (s.ms - lastClipMs) < 2000);

  if (mv < bucketMin) bucketMin = mv;
  if (mv > bucketMax) bucketMax = mv;
  bucketCount++;

  if (bucketCount >= SAMPLES_PER_COLUMN) {
    drawWaveColumn(mv);
    resetBucket();
  }
}

void setup() {
  Serial.begin(115200); // Do not wait for USB; standalone TFT must still work.
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
  pinMode(ECG_PIN, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(ECG_PIN, ADC_11db);

  SPI.begin(TFT_SCK, -1, TFT_MOSI, TFT_CS);

  tft.begin(10000000);
  tft.setRotation(1);
  tft.setTextWrap(false);
  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);
  tft.setCursor(10, 5);
  tft.print("ECG LIVE WAVEFORM");

  resetBucket();
  drawGraphBackground();

  tft.setTextSize(1);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(10, 229);
  tft.print("0.5-40Hz+60Hz notch 25mm/s 20mm/mV");

  showStatus(STATUS_OFF);

#if defined(ESP32)
  // 取樣放在 core 0，Arduino loop()（繪圖、USB）在 core 1。
  xTaskCreatePinnedToCore(samplerTask, "ecg-sampler", 4096, nullptr,
                          5, nullptr, 0);
#endif
}

void loop() {
  OutSample s;
  int handled = 0;
  while (handled < 32 && ringPop(s)) {
    handleOutput(s);
    handled++;
  }
}
