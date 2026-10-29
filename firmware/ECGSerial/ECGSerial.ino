#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

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

// ===== 波形顯示區 =====
constexpr int GRAPH_LEFT   = 10;
constexpr int GRAPH_RIGHT  = 309;
constexpr int GRAPH_TOP    = 65;
constexpr int GRAPH_BOTTOM = 219;

constexpr uint16_t GRID_COLOR = 0x2104;

// 目標每 4000 微秒取樣一次，約 250 Hz。
// 本版為入門顯示程式，繪圖仍可能造成取樣延遲。
constexpr uint32_t SAMPLE_INTERVAL_US = 4000;

// 每 5 筆資料畫一欄，約每秒向右前進 50 欄。
// 保留這 5 筆中的最大值、最小值，避免只抽一筆漏掉尖峰。
constexpr int SAMPLES_PER_COLUMN = 5;

uint32_t nextSampleUs = 0;
uint32_t contactStartMs = 0;

bool contactActive = false;

int graphX = GRAPH_LEFT;
int previousY = 0;
bool previousPointValid = false;

int bucketCount = 0;
int bucketMin = 4095;
int bucketMax = 0;

int displayedStatus = -1;

// 狀態代碼
constexpr int STATUS_OFF  = 0;
constexpr int STATUS_WAIT = 1;
constexpr int STATUS_RUN  = 2;

void resetBucket() {
  bucketCount = 0;
  bucketMin = 4095;
  bucketMax = 0;
}

// 將 ADC 數值換算為畫面高度。
// ADC 越大，畫面位置越高。
int adcToY(int value) {
  value = constrain(value, 0, 4095);

  return GRAPH_BOTTOM -
         (int)((long)value *
               (GRAPH_BOTTOM - GRAPH_TOP) / 4095L);
}

void drawGraphBackground() {
  tft.fillRect(
    GRAPH_LEFT,
    GRAPH_TOP,
    GRAPH_RIGHT - GRAPH_LEFT + 1,
    GRAPH_BOTTOM - GRAPH_TOP + 1,
    ILI9341_BLACK
  );

  for (int x = GRAPH_LEFT; x <= GRAPH_RIGHT; x += 25) {
    tft.drawFastVLine(
      x, GRAPH_TOP,
      GRAPH_BOTTOM - GRAPH_TOP + 1,
      GRID_COLOR
    );
  }

  for (int y = GRAPH_TOP; y <= GRAPH_BOTTOM; y += 25) {
    tft.drawFastHLine(
      GRAPH_LEFT, y,
      GRAPH_RIGHT - GRAPH_LEFT + 1,
      GRID_COLOR
    );
  }

  tft.drawRect(
    GRAPH_LEFT - 1,
    GRAPH_TOP - 1,
    GRAPH_RIGHT - GRAPH_LEFT + 3,
    GRAPH_BOTTOM - GRAPH_TOP + 3,
    ILI9341_WHITE
  );
}

// 擦除一欄舊波形，同時補回格線。
void clearColumn(int x) {
  tft.drawFastVLine(
    x, GRAPH_TOP,
    GRAPH_BOTTOM - GRAPH_TOP + 1,
    ILI9341_BLACK
  );

  if ((x - GRAPH_LEFT) % 25 == 0) {
    tft.drawFastVLine(
      x, GRAPH_TOP,
      GRAPH_BOTTOM - GRAPH_TOP + 1,
      GRID_COLOR
    );
  } else {
    for (int y = GRAPH_TOP; y <= GRAPH_BOTTOM; y += 25) {
      tft.drawPixel(x, y, GRID_COLOR);
    }
  }
}

void showStatus(int status) {
  if (status == displayedStatus) {
    return;
  }

  displayedStatus = status;

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

void drawWaveColumn(int lastValue) {
  clearColumn(graphX);

  int lastY = adcToY(lastValue);
  int topY = adcToY(bucketMax);
  int bottomY = adcToY(bucketMin);

  // 連接前一欄與目前這一欄。
  if (previousPointValid && graphX > GRAPH_LEFT) {
    tft.drawLine(
      graphX - 1, previousY,
      graphX, lastY,
      ILI9341_GREEN
    );
  }

  // 顯示本欄資料的最大、最小範圍。
  tft.drawFastVLine(
    graphX, topY,
    bottomY - topY + 1,
    ILI9341_GREEN
  );

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

  drawGraphBackground();

  tft.setTextSize(1);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(10, 229);
  tft.print("RAW ADC | Battery only on body");

  showStatus(STATUS_OFF);

  nextSampleUs = micros() + SAMPLE_INTERVAL_US;
}

void loop() {
  uint32_t nowUs = micros();

  // 還沒到取樣時間，先返回。
  if ((int32_t)(nowUs - nextSampleUs) < 0) {
    return;
  }

  nextSampleUs += SAMPLE_INTERVAL_US;

  // 若繪圖造成延遲，不快速補讀多筆假裝補回取樣。
  if ((int32_t)(nowUs - nextSampleUs) >= 0) {
    nextSampleUs = nowUs + SAMPLE_INTERVAL_US;
  }

  uint32_t sampleMs = millis();

  bool leadsOff =
    digitalRead(LO_PLUS_PIN) == HIGH ||
    digitalRead(LO_MINUS_PIN) == HIGH;

  // 電極脫落：停止畫新波形。
  if (leadsOff) {
    contactActive = false;
    previousPointValid = false;
    resetBucket();
    showStatus(STATUS_OFF);
    sendSample(sampleMs, 0, STATUS_OFF);
    return;
  }

  // 剛重新接觸，先等待訊號穩定。
  if (!contactActive) {
    contactActive = true;
    contactStartMs = millis();
    previousPointValid = false;
    resetBucket();
    showStatus(STATUS_WAIT);
  }

  int rawValue = analogRead(ECG_PIN);

  // 重新接觸後等待 3 秒。
  if (millis() - contactStartMs < 3000) {
    sendSample(sampleMs, rawValue, STATUS_WAIT);
    return;
  }

  sendSample(sampleMs, rawValue, STATUS_RUN);
  showStatus(STATUS_RUN);

  if (rawValue < bucketMin) {
    bucketMin = rawValue;
  }

  if (rawValue > bucketMax) {
    bucketMax = rawValue;
  }

  bucketCount++;

  if (bucketCount >= SAMPLES_PER_COLUMN) {
    drawWaveColumn(rawValue);
    resetBucket();
  }
}