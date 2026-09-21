import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCalibration } from './calibration.js';

test('builds reliability and risk-coverage tables from objective labels', () => {
  const report = analyzeCalibration([
    { id: 'a', probability: 0.9, correct: true },
    { id: 'b', probability: 0.8, correct: true },
    { id: 'c', probability: 0.7, correct: false },
    { id: 'd', probability: 0.2, correct: false },
  ], { bins: 5, coveragePoints: 4 });
  assert.equal(report.accuracy, 0.5);
  assert.equal(report.observations, 4);
  assert.equal(report.riskCoverage[0]!.risk, 0);
  assert.equal(report.riskCoverage.at(-1)!.coverage, 1);
  assert.ok(report.expectedCalibrationError >= 0);
});

test('calibration validates probability vectors and settings', () => {
  assert.throws(() => analyzeCalibration([{ id: 'bad', probability: 1.1, correct: true }]), /Invalid/);
  assert.throws(() => analyzeCalibration([], { bins: 10 }), /at least one/);
});
