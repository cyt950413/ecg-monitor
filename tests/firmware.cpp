#include <cassert>
#include <cmath>
#include <iostream>
#include "../firmware/ECGSerial/ECGSerial.ino"

static void tick(uint32_t ms) { samplerTick(ms); loop(); }

static double toneAmplitude(double hz, double fs) {
  MonitorFilter f;
  double re = 0, im = 0;
  int n = 0;
  for (int i = 0; i < 20000; i++) {
    double x = 2000 + 300 * sin(2 * M_PI * hz * i / fs);
    double y = f.process(x);
    if (i >= 5000) {
      re += y * cos(2 * M_PI * hz * i / fs);
      im -= y * sin(2 * M_PI * hz * i / fs);
      n++;
    }
  }
  return 2 * std::hypot(re, im) / n / 300;
}

int main() {
  static_assert(TFT_CS == 27 && TFT_DC == 25 && TFT_RST == 26 && TFT_SCK == 18 && TFT_MOSI == 23);
  static_assert(ECG_PIN == 34 && LO_PLUS_PIN == 13 && LO_MINUS_PIN == 14);

  // Coefficients equal scipy.signal.butter(2, fc, fs=250).
  Biquad hp = makeHighpass(0.5, 250), lp = makeLowpass(40, 250);
  assert(std::fabs(hp.b0 - 0.991153595101663) < 1e-12 && std::fabs(hp.a1 + 1.9822289297925284) < 1e-12 && std::fabs(hp.a2 - 0.9823854506141251) < 1e-12);
  assert(std::fabs(lp.b0 - 0.1453238838770424) < 1e-12 && std::fabs(lp.a1 + 0.6710290907740961) < 1e-12 && std::fabs(lp.a2 - 0.2523246262822658) < 1e-12);

  // Monitor band: 0.1 Hz drift removed, 10 Hz kept, 60 Hz and 100 Hz removed.
  double g01 = toneAmplitude(0.1, 250), g10 = toneAmplitude(10, 250), g60 = toneAmplitude(60, 250), g100 = toneAmplitude(100, 250);
  assert(g01 < 0.05 && g10 > 0.95 && g10 < 1.01 && g60 < 0.001 && g100 < 0.15);
  std::cout << "Monitor filter gain: 0.1Hz " << g01 << ", 10Hz " << g10 << ", 60Hz " << g60 << ", 100Hz " << g100 << "\n";

  setup();
  // Lead off: one output every 4 ticks, exact 4 ms timestamps.
  lead = 1;
  for (uint32_t ms = 1; ms <= 4; ms++) tick(ms);
  assert(Serial.output == "4,0,0\n");
  assert(displayedStatus == STATUS_OFF);

  // Contact: average of 16 reads, settling for 3 s.
  lead = 0; raw = 2048;
  for (uint32_t ms = 5; ms <= 8; ms++) tick(ms);
  assert(Serial.output.find("8,2048,1\n") != std::string::npos);
  assert(displayedStatus == STATUS_WAIT);

  // Saturation in a single sub-read must survive averaging.
  raw = 4095; tick(9); raw = 2048;
  for (uint32_t ms = 10; ms <= 12; ms++) tick(ms);
  assert(Serial.output.find("12,4095,1\n") != std::string::npos);
  raw = 1; tick(13); raw = 0; tick(14); raw = 2048; tick(15); tick(16);
  assert(Serial.output.find("16,0,1\n") != std::string::npos);

  for (uint32_t ms = 17; ms <= 3008; ms++) tick(ms);
  assert(Serial.output.find("3008,2048,2\n") != std::string::npos);
  assert(displayedStatus == STATUS_RUN);

  int before = tft.columns;
  for (uint32_t ms = 3009; ms <= 3028; ms++) tick(ms);  // 5 outputs → one column
  assert(tft.columns > before);

  // Non-blocking USB: a full TX buffer drops the record but keeps the TFT running.
  Serial.room = 0;
  auto size = Serial.output.size();
  for (uint32_t ms = 3029; ms <= 3032; ms++) tick(ms);
  assert(Serial.output.size() == size);
  Serial.room = 100;

  // Lead off resets drawing state.
  lead = 1;
  for (uint32_t ms = 3033; ms <= 3036; ms++) tick(ms);
  assert(displayedStatus == STATUS_OFF && bucketCount == 0 && !previousPointValid);
  assert(Serial.output.find("3036,0,0\n") != std::string::npos);

  // Ring buffer never blocks the sampler: overflow is counted, not waited on.
  lead = 0;
  for (uint32_t ms = 4001; ms <= 4000 + 4 * (RING_SIZE + 10); ms++) samplerTick(ms);
  assert(droppedSamples >= 10);

  std::cout << "PASS: pins, 1 kHz→250 Hz decimation, exact 4 ms timestamps, sticky saturation, settling, TFT drawing, non-blocking TX, lead-off reset, ring overflow\n";
}
