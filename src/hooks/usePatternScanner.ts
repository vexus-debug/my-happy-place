import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchTickers, fetchKlines } from '@/lib/bybit-api';
import { detectCandlestickPatterns, type CandlestickPattern } from '@/lib/candlestick-patterns';
import { detectChartPatterns, type ChartPattern } from '@/lib/chart-patterns';
import { detectMarketStructure, type MarketStructureEvent } from '@/lib/market-structure';
import type { Timeframe, AssetTrend } from '@/types/scanner';
import { TIMEFRAME_LABELS } from '@/types/scanner';

const SCAN_TIMEFRAMES: Timeframe[] = ['5', '15', '60', '240', 'D', 'W'];
const TOP_SYMBOLS = 50;
const MAX_PER_TIMEFRAME = 10;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

export interface DetectedPattern {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  pattern: CandlestickPattern | ChartPattern | MarketStructureEvent;
  price: number;
  detectedAt: number;
  formedAt: number;
  category: 'candlestick' | 'chart' | 'structure';
  trendAligned?: boolean; // true if pattern direction matches current trend
}

export interface PatternGroup {
  timeframe: Timeframe;
  label: string;
  patterns: DetectedPattern[];
}

/**
 * Boost significance when pattern aligns with the current trend on that timeframe.
 * Aligned patterns get promoted: low→medium, medium→high.
 * Counter-trend patterns get demoted: high→medium, medium→low.
 */
function adjustSignificance(
  baseSig: 'high' | 'medium' | 'low',
  patternType: string,
  symbol: string,
  tf: Timeframe,
  trendAssets: AssetTrend[]
): { significance: 'high' | 'medium' | 'low'; aligned: boolean } {
  // Find trend data for this symbol
  const fullSymbol = symbol.includes('USDT') ? symbol : `${symbol}USDT`;
  const asset = trendAssets.find(a => a.symbol === fullSymbol);
  if (!asset) return { significance: baseSig, aligned: false };

  const signal = asset.signals[tf];
  if (!signal || !signal.direction) return { significance: baseSig, aligned: false };

  const trendDir = signal.direction; // 'bull' | 'bear'
  const patternDir = patternType === 'bullish' ? 'bull' : patternType === 'bearish' ? 'bear' : null;

  if (!patternDir) return { significance: baseSig, aligned: false };

  const aligned = patternDir === trendDir;

  if (aligned) {
    // Promote significance
    const promoted = baseSig === 'low' ? 'medium' : baseSig === 'medium' ? 'high' : 'high';
    return { significance: promoted, aligned: true };
  } else {
    // Demote significance (counter-trend)
    const demoted = baseSig === 'high' ? 'medium' : baseSig === 'medium' ? 'low' : 'low';
    return { significance: demoted, aligned: false };
  }
}

export function usePatternScanner(trendAssets: AssetTrend[] = []) {
  const [candlestickPatterns, setCandlestickPatterns] = useState<DetectedPattern[]>([]);
  const [chartPatterns, setChartPatterns] = useState<DetectedPattern[]>([]);
  const [structurePatterns, setStructurePatterns] = useState<DetectedPattern[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScanTime, setLastScanTime] = useState<number>(0);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const scanningRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const trendAssetsRef = useRef(trendAssets);
  trendAssetsRef.current = trendAssets;

  const runScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);

    try {
      const categories: ('spot' | 'linear')[] = ['linear', 'spot'];
      const symbolMap = new Map<string, { symbol: string; category: 'spot' | 'linear'; price: number }>();

      for (const cat of categories) {
        try {
          const tickerData = await fetchTickers(cat);
          if (tickerData.retCode === 0 && tickerData.result?.list) {
            const sorted = tickerData.result.list
              .filter(t => t.symbol.endsWith('USDT'))
              .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
              .slice(0, TOP_SYMBOLS);
            for (const t of sorted) {
              if (!symbolMap.has(t.symbol) || cat === 'linear') {
                symbolMap.set(t.symbol, { symbol: t.symbol, category: cat, price: parseFloat(t.lastPrice) });
              }
            }
          }
        } catch { /* skip */ }
      }

      const symbols = Array.from(symbolMap.values());
      const totalOps = symbols.length * SCAN_TIMEFRAMES.length;
      setScanProgress({ current: 0, total: totalOps });

      const newCandlestick: DetectedPattern[] = [];
      const newChart: DetectedPattern[] = [];
      const newStructure: DetectedPattern[] = [];
      let progress = 0;
      const currentTrends = trendAssetsRef.current;

      const BATCH_SIZE = 8;
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async ({ symbol, category, price }) => {
          for (const tf of SCAN_TIMEFRAMES) {
            try {
              const candles = await fetchKlines(symbol, tf, category);
              if (candles.length < 20) { progress++; continue; }

              const now = Date.now();
              const sym = symbol.replace('USDT', '');

              const cPatterns = detectCandlestickPatterns(candles);
              for (const p of cPatterns) {
                const formedAt = candles[p.candleIndex]?.time ?? now;
                const { significance, aligned } = adjustSignificance(p.significance, p.type, sym, tf, currentTrends);
                newCandlestick.push({
                  id: `cs-${symbol}-${tf}-${p.name}-${now}`,
                  symbol: sym, timeframe: tf,
                  pattern: { ...p, significance },
                  price, detectedAt: now, formedAt, category: 'candlestick',
                  trendAligned: aligned,
                });
              }

              const chPatterns = detectChartPatterns(candles);
              for (const p of chPatterns) {
                const formedAt = candles[p.endIndex]?.time ?? now;
                const { significance, aligned } = adjustSignificance(p.significance, p.type, sym, tf, currentTrends);
                newChart.push({
                  id: `ch-${symbol}-${tf}-${p.name}-${now}`,
                  symbol: sym, timeframe: tf,
                  pattern: { ...p, significance },
                  price, detectedAt: now, formedAt, category: 'chart',
                  trendAligned: aligned,
                });
              }

              const msEvents = detectMarketStructure(candles);
              for (const p of msEvents) {
                const formedAt = candles[p.candleIndex]?.time ?? now;
                const { significance, aligned } = adjustSignificance(p.significance, p.type, sym, tf, currentTrends);
                newStructure.push({
                  id: `ms-${symbol}-${tf}-${p.name}-${now}`,
                  symbol: sym, timeframe: tf,
                  pattern: { ...p, significance },
                  price, detectedAt: now, formedAt, category: 'structure',
                  trendAligned: aligned,
                });
              }
            } catch { /* skip */ }
            progress++;
            setScanProgress({ current: progress, total: totalOps });
          }
        }));

        if (i + BATCH_SIZE < symbols.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      setCandlestickPatterns(newCandlestick);
      setChartPatterns(newChart);
      setStructurePatterns(newStructure);
      setLastScanTime(Date.now());
    } catch (err) {
      console.error('Pattern scan error:', err);
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    runScan();
    intervalRef.current = setInterval(runScan, SCAN_INTERVAL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [runScan]);

  /** Sort by most recent first (formedAt desc), then by significance */
  const groupByTimeframe = (patterns: DetectedPattern[]): PatternGroup[] => {
    const groups: PatternGroup[] = [];
    for (const tf of SCAN_TIMEFRAMES) {
      const tfPatterns = patterns
        .filter(p => p.timeframe === tf)
        .sort((a, b) => {
          // Primary: most recent first
          const timeDiff = b.formedAt - a.formedAt;
          if (timeDiff !== 0) return timeDiff;
          // Secondary: trend-aligned first
          if (a.trendAligned !== b.trendAligned) return a.trendAligned ? -1 : 1;
          // Tertiary: significance
          const sigOrder = { high: 0, medium: 1, low: 2 };
          return sigOrder[a.pattern.significance] - sigOrder[b.pattern.significance];
        })
        .slice(0, MAX_PER_TIMEFRAME);
      if (tfPatterns.length > 0) {
        groups.push({ timeframe: tf, label: TIMEFRAME_LABELS[tf], patterns: tfPatterns });
      }
    }
    return groups;
  };

  return {
    candlestickPatterns,
    chartPatterns,
    structurePatterns,
    candlestickGroups: groupByTimeframe(candlestickPatterns),
    chartGroups: groupByTimeframe(chartPatterns),
    structureGroups: groupByTimeframe(structurePatterns),
    scanning,
    lastScanTime,
    scanProgress,
    runScan,
  };
}
