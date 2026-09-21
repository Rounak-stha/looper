export interface ConfidenceObservation {
  id: string;
  probability: number;
  correct: boolean;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
  calibrationGap: number;
}

export interface RiskCoveragePoint {
  coverage: number;
  risk: number;
  threshold: number;
  accepted: number;
}

export interface CalibrationReport {
  observations: number;
  accuracy: number;
  meanConfidence: number;
  expectedCalibrationError: number;
  maximumCalibrationError: number;
  reliability: ReliabilityBin[];
  riskCoverage: RiskCoveragePoint[];
}

/** Computes calibration only from objective labels; model self-reports never define correctness. */
export function analyzeCalibration(
  observations: ConfidenceObservation[], options: { bins?: number; coveragePoints?: number } = {},
): CalibrationReport {
  const bins = options.bins ?? 10;
  const coveragePoints = options.coveragePoints ?? 20;
  if (!Number.isInteger(bins) || bins < 2) throw new Error('Calibration bins must be an integer of at least 2');
  if (!Number.isInteger(coveragePoints) || coveragePoints < 1) throw new Error('Coverage points must be a positive integer');
  for (const observation of observations) {
    if (!observation.id || !Number.isFinite(observation.probability)
      || observation.probability < 0 || observation.probability > 1) {
      throw new Error(`Invalid confidence observation '${observation.id}'`);
    }
  }
  if (!observations.length) throw new Error('Calibration requires at least one observation');

  const grouped = Array.from({ length: bins }, () => [] as ConfidenceObservation[]);
  for (const observation of observations) {
    grouped[Math.min(bins - 1, Math.floor(observation.probability * bins))]!.push(observation);
  }
  const reliability = grouped.map((items, index): ReliabilityBin => {
    const meanConfidence = mean(items.map(({ probability }) => probability));
    const accuracy = mean(items.map(({ correct }) => Number(correct)));
    return {
      lower: index / bins, upper: (index + 1) / bins, count: items.length,
      meanConfidence, accuracy, calibrationGap: items.length ? Math.abs(meanConfidence - accuracy) : 0,
    };
  });
  const nonEmpty = reliability.filter(({ count }) => count > 0);
  const sorted = [...observations].sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  const acceptedCounts = new Set(Array.from({ length: coveragePoints }, (_, index) =>
    Math.max(1, Math.ceil((index + 1) * sorted.length / coveragePoints))));
  acceptedCounts.add(sorted.length);
  const riskCoverage = [...acceptedCounts].sort((a, b) => a - b).map((accepted): RiskCoveragePoint => {
    const included = sorted.slice(0, accepted);
    return {
      coverage: accepted / sorted.length,
      risk: 1 - mean(included.map(({ correct }) => Number(correct))),
      threshold: included.at(-1)!.probability,
      accepted,
    };
  });
  return {
    observations: observations.length,
    accuracy: mean(observations.map(({ correct }) => Number(correct))),
    meanConfidence: mean(observations.map(({ probability }) => probability)),
    expectedCalibrationError: nonEmpty.reduce((sum, bin) => sum + bin.count / observations.length * bin.calibrationGap, 0),
    maximumCalibrationError: Math.max(...nonEmpty.map(({ calibrationGap }) => calibrationGap)),
    reliability, riskCoverage,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
