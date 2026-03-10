import { PatternPageShell } from '@/components/PatternPageShell';
import { usePatternScanner } from '@/hooks/usePatternScanner';

const CandlestickPatternsPage = () => {
  const { candlestickGroups, scanning, lastScanTime, scanProgress, runScan } = usePatternScanner();

  return (
    <PatternPageShell
      title="Candlestick Patterns"
      subtitle="Doji, Engulfing, Hammer, Morning Star, and more"
      groups={candlestickGroups}
      scanning={scanning}
      lastScanTime={lastScanTime}
      scanProgress={scanProgress}
      onRescan={runScan}
    />
  );
};

export default CandlestickPatternsPage;
