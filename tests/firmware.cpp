#include <cassert>
#include <iostream>
#include "../firmware/ECGSerial/ECGSerial.ino"
int main(){
 static_assert(TFT_CS==27&&TFT_DC==25&&TFT_RST==26&&TFT_SCK==18&&TFT_MOSI==23);
 static_assert(ECG_PIN==34&&LO_PLUS_PIN==13&&LO_MINUS_PIN==14);
 setup();lead=1;clockUs=4000;loop();assert(Serial.output=="4,0,0\n");
 lead=0;clockUs=8000;loop();assert(displayedStatus==STATUS_WAIT);assert(Serial.output.find("8,2048,1\n")!=std::string::npos);
 clockUs=3008000;loop();assert(displayedStatus==STATUS_RUN);assert(Serial.output.find("3008,2048,2\n")!=std::string::npos);
 int before=tft.columns;for(int i=0;i<5;i++){clockUs+=4000;loop();}assert(tft.columns>before);
 Serial.room=0;auto size=Serial.output.size();clockUs+=4000;loop();assert(Serial.output.size()==size);
 lead=1;clockUs+=4000;loop();assert(displayedStatus==STATUS_OFF&&bucketCount==0&&!previousPointValid);
 std::cout<<"PASS: original pins, lead-off CSV, settling CSV, ready CSV, TFT drawing, nonblocking TX, lead-off reset\n";
}
