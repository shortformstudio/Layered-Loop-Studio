import React from "react";
import { View, StyleSheet } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";

interface WaveformBarsProps {
  data: number[];
  width: number;
  height: number;
  startRatio: number;
  endRatio: number;
  activeColor: string;
  inactiveColor: string;
  /** Ratios (0..1) where beat grid lines should be drawn beneath the bars */
  beatMarkers?: number[];
  markerColor?: string;
}

export default function WaveformBars({
  data,
  width,
  height,
  startRatio,
  endRatio,
  activeColor,
  inactiveColor,
  beatMarkers,
  markerColor = "rgba(245,240,232,0.22)",
}: WaveformBarsProps) {
  const barCount = Math.max(1, data.length);
  const gap = 2;
  const barWidth = Math.max(1, Math.min(width, (width - gap * (barCount - 1)) / barCount));

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        {beatMarkers && beatMarkers.length > 0
          ? beatMarkers.map((m, i) => (
              <Line
                key={`b${i}`}
                x1={m * width}
                y1={0}
                x2={m * width}
                y2={height}
                stroke={markerColor}
                strokeWidth={1}
              />
            ))
          : null}
        {data.map((value, i) => {
          const ratio = i / barCount;
          const isActive = ratio >= startRatio && ratio <= endRatio;
          const barHeight = Math.max(3, value * height * 0.9);
          const x = i * (barWidth + gap);
          const y = (height - barHeight) / 2;
          return (
            <Rect
              key={i}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={barWidth / 2}
              fill={isActive ? activeColor : inactiveColor}
            />
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({});
