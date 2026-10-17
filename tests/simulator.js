'use strict';

const assert = require('assert');
const Simulator = require('../types/simulator');

describe('Simulator', function () {
  this.timeout(30000);

  it('bands levels 1-2-5', function () {
    assert.deepStrictEqual([1, 2, 4, 5, 9, 10, 19, 20, 49, 50, 99, 100, 250, 1999, 2000].map(Simulator.bandFor),
      [1, 2, 2, 5, 5, 10, 10, 20, 20, 50, 50, 100, 200, 1000, 2000]);
  });

  it('merges metrics by summing, keeping extremes for max and min', function () {
    const merged = Simulator.merge(
      Simulator.merge({}, { players: 2, bands: { 1: { wins: 3 } }, final: { max: 9, min: 4 } }),
      { players: 3, bands: { 1: { wins: 1 }, 2: { wins: 5 } }, final: { max: 7, min: 2 } }
    );
    assert.deepStrictEqual(merged, { players: 5, bands: { 1: { wins: 4 }, 2: { wins: 5 } }, final: { max: 9, min: 2 } });
  });

  it('gives the same totals however players are split', function () {
    const simulator = new Simulator({ players: 6, days: 10, seed: 'split' });
    const whole = simulator.run();
    const parts = [[0, 2], [2, 5], [5, 6]].map(([from, to]) => simulator.run(from, to));
    const merged = parts.reduce((total, part) => Simulator.merge(total, part), {});
    assert.strictEqual(merged.encounters, whole.encounters);
    assert.deepStrictEqual(merged.levels, whole.levels);
    assert.deepStrictEqual(simulator.summarize(merged), simulator.summarize(whole));
  });

  it('records every level reached', function () {
    const simulator = new Simulator({ players: 4, days: 5, seed: 'levels' });
    const metrics = simulator.run();
    const { summary } = simulator.summarize(metrics);
    for (let level = 2; level <= summary.minLevel; level++) {
      assert.strictEqual(metrics.levels[level].players, 4, `level ${level}`);
    }
    assert.ok(metrics.encounters > 0);
    assert.match(simulator.format(metrics), /days\/level/);
  });

  it('keeps fights winnable, short, and each level slower than the last', function () {
    const simulator = new Simulator({ players: 12, days: 120, seed: 'balance' });
    const { bands, milestones } = simulator.summarize(simulator.run());
    for (const band of bands.filter((b) => b.encounters >= 200)) {
      assert.ok(band.winRate >= 65 && band.winRate <= 97, `levels ${band.levels}+: win ${band.winRate}%`);
      assert.ok(band.timeouts <= 2, `levels ${band.levels}+: ${band.timeouts}% timeouts`);
    }
    const paced = milestones.filter((m) => m.daysPerLevel != null);
    assert.ok(paced.length >= 4);
    for (let i = 1; i < paced.length; i++) {
      assert.ok(paced[i].daysPerLevel >= paced[i - 1].daysPerLevel, `level ${paced[i].level} faster than ${paced[i - 1].level}`);
    }
    const hundred = milestones.find((m) => m.level === 100);
    assert.ok(hundred && hundred.reached === 100, 'everyone reaches level 100');
    assert.ok(hundred.days >= 80 && hundred.days <= 100, `level 100 on day ${hundred.days}`);
  });
});
