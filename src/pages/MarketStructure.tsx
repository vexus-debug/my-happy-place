import { PatternPageShell } from '@/components/PatternPageShell';
import { usePatternScanner } from '@/hooks/usePatternScanner';

const MarketStructurePage = () => {
  const { structureGroups, scanning, lastScanTime, scanProgress, runScan } = usePatternScanner();

  return (
    <PatternPageShell
      title="Market Structure"
      subtitle="BOS, CHoCH, FVG, Order Blocks, Liquidity"
      groups={structureGroups}
      scanning={scanning}
      lastScanTime={lastScanTime}
      scanProgress={scanProgress}
      onRescan={runScan}
    />
  );
};

export default MarketStructurePage;
