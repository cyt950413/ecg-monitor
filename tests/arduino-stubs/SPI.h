#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include <algorithm>
constexpr int INPUT=0,HIGH=1,ADC_11db=3;
inline uint32_t clockUs=0; inline int lead=0,raw=2048;
inline uint32_t micros(){return clockUs;} inline uint32_t millis(){return clockUs/1000;}
inline int digitalRead(int){return lead;} inline int analogRead(int){return raw;}
inline void pinMode(int,int){} inline void analogReadResolution(int){} inline void analogSetPinAttenuation(int,int){}
inline int constrain(int v,int lo,int hi){return std::clamp(v,lo,hi);}
struct SPIClass{void begin(int,int,int,int){}};inline SPIClass SPI;
struct SerialClass{int room=100;std::string output;void begin(int){}int availableForWrite(){return room;}void write(const uint8_t* p,int n){output.append((const char*)p,n);}};inline SerialClass Serial;
