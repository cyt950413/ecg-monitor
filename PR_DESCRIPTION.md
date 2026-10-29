以 Web Serial 建立 ESP32 ECG 即時監測網站，並保留原 TFT 功能

目前 index.html 僅有歡迎頁。此變更新增 USB Web Serial 連線、原始 ADC 波形、電極狀態與 3 秒穩定狀態、暫停、時間窗、CSV 匯出及獨立示範模式。

新增 firmware/ECGSerial/ECGSerial.ino，以原 AAAA.ino 為基礎保留所有接腳、TFT 繪圖及等待邏輯，並傳送 115200 baud 的 timestamp_ms,raw_adc,status CSV。TX 空間不足時略過資料以維持 TFT 運作。附使用說明、協定、瀏覽器測試及韌體主機邏輯測試。

驗證：Chromium 模擬 Web Serial 與手機版面測試通過；C++17 主機替身測試在 -Wall -Wextra -Werror 下通過。詳見 TEST_RESULTS.md。尚無 ESP32 工具鏈與實體硬體，需後續實機編譯、USB/TFT 驗證。

本 PR 不合併、不部署；合併前請確認既有 GitHub Pages 設定。
