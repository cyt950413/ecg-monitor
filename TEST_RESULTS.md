# 測試紀錄

日期：2026-10-29（Asia/Taipei）

## 通過

- JavaScript 語法檢查。
- Chromium + Playwright：模擬 Web Serial 的分段 CSV / CRLF、多筆資料、無效數字/欄位與超長行過濾。
- 接觸狀態、115200 開埠設定、暫停時持續接收、CSV 下載、取消 reader 並關閉 port。
- 示範與 USB 資料隔離、清除資料、32-bit 時間溢位、15,000 筆上限。
- 390px 手機版面無水平溢出；測試期間沒有 JavaScript pageerror。
- 不支援 Web Serial 時停用連線按鈕。
- C++17 / `-Wall -Wextra -Werror` 主機替身測試：原接腳不變、脫落/等待/正常 CSV、三秒穩定等待、TFT 繪圖、TX 滿時略過、不阻塞與脫落後重設。

## 尚未驗證

- ESP32 工具鏈實際編譯：環境沒有 arduino-cli / ESP32 core / Adafruit libraries。
- 實體 USB 序列埠、ESP32 ADC、TFT 畫面及長時間取樣穩定度：無硬體。
- 不同電腦/驅動與其他 Chrome/Edge 版本。

測試皆使用模擬資料，不代表臨床有效性。
