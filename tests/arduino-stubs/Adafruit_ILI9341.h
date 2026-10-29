#pragma once
constexpr int ILI9341_BLACK=0,ILI9341_WHITE=65535,ILI9341_RED=1,ILI9341_YELLOW=2,ILI9341_GREEN=3;
struct Adafruit_ILI9341 {
 int columns=0;
 Adafruit_ILI9341(int,int,int){}
 template<class... T>void begin(T...){} template<class... T>void setRotation(T...){}
 template<class... T>void setTextWrap(T...){} template<class... T>void fillScreen(T...){}
 template<class... T>void setTextColor(T...){} template<class... T>void setTextSize(T...){}
 template<class... T>void setCursor(T...){} template<class... T>void print(T...){}
 template<class... T>void fillRect(T...){} template<class... T>void drawRect(T...){}
 template<class... T>void drawFastVLine(T...){columns++;} template<class... T>void drawFastHLine(T...){}
 template<class... T>void drawPixel(T...){} template<class... T>void drawLine(T...){}
};
