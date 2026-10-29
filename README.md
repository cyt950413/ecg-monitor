# ECG Monitor

ESP32 + AD8232 的 USB 序列心電波形監測介面。直接修改根目錄 `index.html`，沒有建置步驟、CDN 或後端；資料僅保留於瀏覽器記憶體。

## 使用

1. Arduino IDE 安裝 Espressif ESP32 board package、Adafruit GFX Library、Adafruit ILI9341（以及 IDE 提示的 Adafruit BusIO 相依套件）。
2. 開啟 `firmware/ECGSerial/ECGSerial.ino`，選擇實際使用的 ESP32 開發板與序列埠，編譯後上傳。以原附檔的傳統 ESP32 接腳為準，不適用所有 ESP32 變體。
3. 關閉 Arduino Serial Monitor / Serial Plotter，以免占用序列埠。
4. 在現有 HTTPS 網站開啟 `index.html`，或本機執行 `python3 -m http.server 8000` 後以電腦版 Chrome / Edge 開啟 `http://localhost:8000`。不要依賴直接開啟 file URL。
5. 網頁選擇 **115200**，按「連接 ESP32」，從瀏覽器選擇裝置。其餘鮑率選項只有在同步修改韌體 `Serial.begin` 時才適用。

本次變更不部署或發布網站。GitHub Pages 若已設定，請於審查及合併時自行確認其發布行為。

## 原接線與 TFT 功能

| 功能                  | ESP32 GPIO   |
| --------------------- | ------------ |
| ILI9341 CS / DC / RST | 27 / 25 / 26 |
| TFT SCK / MOSI        | 18 / 23      |
| AD8232 OUTPUT         | 34           |
| AD8232 LO+ / LO−      | 13 / 14      |

保留 12 位元 ADC、原 SPI/TFT 設定、波形範圍、格線、每五筆最大/最小值繪圖與三種 TFT 接觸狀態。電極脫落時停止 TFT 新波形；重新接觸後等待三秒。未連接瀏覽器仍可使用 TFT。原檔案僅作為程式來源，未將其中註解視為額外使用者指示。

## 序列協定

115200 baud、8N1、ASCII CSV，每筆以 LF 換行（網頁也接受 CRLF）：

```text
1234,2048,2
1238,0,0
1242,1980,1
```

欄位為 `timestamp_ms,raw_adc,status`：

- `timestamp_ms`：ESP32 `millis()`，unsigned 32-bit。網頁處理約 49.7 天溢位與裝置重新啟動，CSV 同時保留原裝置時間與正規化時間。
- `raw_adc`：0–4095 的原始值，未做電壓校正；電極脫落時送 0 作為佔位，不畫成有效訊號。
- `status`：0 電極脫落、1 等待穩定、2 正常。

目標取樣週期 4000 μs（250 Hz）。此版本維持原本單迴圈 TFT 架構，繪圖可能延遲取樣；不補造樣本。序列 TX 空間不足時略過整筆資料，避免因電腦未讀取阻塞 TFT。網頁接收率是有效資料筆數/實際經過時間；超過 100 ms 的資料缺口不連線繪圖，實際取樣時間以裝置時間戳為準。

## 網頁功能

- 使用者主動選擇 USB 序列埠；錯誤、取消、無支援、安全來源需求與中斷連線提示。
- Canvas 原始 ECG、5/10/20 秒時間窗、接觸狀態、ADC、接收率、樣本計數。
- 暫停僅凍結波形，接收不中斷；清除資料會清空即時與凍結緩衝區。
- 記憶體保留最近 60 秒且最多 15,000 筆；匯出此範圍 CSV（`time_ms,device_ms,adc,status,source`）。
- 示範與 USB 模式互斥，切換來源時清除舊資料，CSV 明確標記 `demo` / `usb`。
- 忽略不符合協定的開機日誌、超長行、錯誤欄位及超出範圍資料。

## 驗證

瀏覽器測試需 Node.js、Playwright 與 Chromium；執行 `npm install --no-save --package-lock=false playwright@1.62.1` 安裝測試相依套件（不影響網站執行）。測試使用 Playwright route 在 `https://localhost/` 提供 HTML，並模擬 Web Serial，不會連外或連接真實裝置。

```sh
node tests/browser.cjs
# 若 Chromium 不在 /usr/bin/chromium：
CHROMIUM_PATH=/path/to/chromium node tests/browser.cjs

g++ -std=c++17 -Wall -Wextra -Werror -I tests/arduino-stubs tests/firmware.cpp -o /tmp/ecg-firmware-test
/tmp/ecg-firmware-test
```

韌體測試使用主機端 Arduino/TFT 替身，驗證邏輯，不等同 ESP32 工具鏈編譯。環境未提供 arduino-cli、ESP32 core 或實體裝置；尚需 Arduino IDE 實際編譯與板端驗證。

實機驗收：確認 TFT 狀態與網頁一致、電極重接等待三秒、USB 拔除/重連可再次選埠、關閉網頁仍可獨立使用 TFT、CSV 時間與訊號一致。人體量測需適當醫療級電氣隔離；未隔離時先移除人體電極，使用訊號模擬器測試。本專案僅供學習，不供診斷。
