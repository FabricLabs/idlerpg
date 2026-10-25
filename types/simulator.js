'use strict';

/**
 * @fileoverview Headless IdleRPG progression simulator for testing and
 * balancing at scale. Each simulated player is a real `Player` meeting real
 * `@fabric/rpg` encounters, resolved by `Player#resolve` exactly as the engine
 * does. Idle ticks between encounters are skipped in one step (the wait is
 * drawn from the same geometric distribution as rolling `luck` every tick),
 * so years of play cost only the encounters themselves. Players are seeded by
 * index, so any split of players across workers gives the same totals.
 */

const Battle = require('@fabric/rpg/types/battle');
const Encounter = require('@fabric/rpg/types/encounter');
const items = require('@fabric/rpg/functions/items');
const { placeFor } = require('@fabric/rpg/functions/places');
const { seeded } = require('@fabric/rpg/functions/random');
const Player = require('./player');

const { experienceForLevel } = Player;

const {
  ENCOUNTER_CHANCE,
  ENCOUNTER_WEIGHTS,
  EXPERIENCE_RATE,
  LEVEL_OFFSET,
  LEVEL_OFFSET_MAX,
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  TICK_INTERVAL
} = require('../constants');

const DAY_MS = 24 * 60 * 60 * 1000;
const BAND_STEPS = [1, 2, 5];

/**
 * Start of the 1-2-5 band a level falls in: 1, 2, 5, 10, 20, 50, 100, …
 * @param {number} level
 * @returns {number}
 */
function bandFor (level) {
  let best = 1;
  for (let scale = 1; scale <= level; scale *= 10) {
    for (const step of BAND_STEPS) {
      if (step * scale <= level) best = step * scale;
    }
  }
  return best;
}

function emptyBand () {
  return {
    encounters: 0,
    monsters: 0,
    wins: 0,
    losses: 0,
    rounds: 0,
    timeouts: 0,
    healthLeft: 0,
    levelDelta: 0,
    idleExperience: 0,
    killExperience: 0,
    blessingExperience: 0,
    gear: 0,
    rare: 0,
    legendary: 0,
    upgrades: 0,
    wealthLost: 0,
    wealthEarned: 0,
    damage: 0,
    health: 0,
    armor: 0,
    weaponLevel: 0
  };
}

/**
 * Add `source` into `target`, key by key. Keys named `max` / `min` keep the
 * extreme instead of summing.
 * @param {Object} target
 * @param {Object} source
 * @returns {Object} `target`
 */
function merge (target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object') {
      target[key] = merge(target[key] || {}, value);
    } else if (key === 'max') {
      if (value != null) target[key] = target[key] == null ? value : Math.max(target[key], value);
      else if (!(key in target)) target[key] = null;
    } else if (key === 'min') {
      if (value != null) target[key] = target[key] == null ? value : Math.min(target[key], value);
      else if (!(key in target)) target[key] = null;
    } else {
      target[key] = (target[key] || 0) + value;
    }
  }
  return target;
}

class Simulator {
  /**
   * @param {Object} [settings]
   * @param {number} [settings.players=100] Players simulated by `run()`.
   * @param {number} [settings.days=365] Days of continuous presence each.
   * @param {number} [settings.ticks] Ticks each (overrides `days`).
   * @param {string} [settings.seed='simulation']
   * @param {number} [settings.channels=27] Distinct places players idle in.
   * @param {number} [settings.luck] Encounter chance per tick (engine default).
   * @param {Object} [settings.encounterWeights] Encounter type weights (engine default).
   * @param {number} [settings.levelRange] Passed to every `Encounter`.
   * @param {number} [settings.levelSpread] Passed to every `Encounter`.
   * @param {number} [settings.levelOffset] Passed to every `Encounter` (engine default).
   * @param {number} [settings.levelOffsetMax] Passed to every `Encounter` (engine default).
   * @param {number} [settings.experienceRate] Passed to every `Encounter` (engine default).
   * @param {number} [settings.perTickExperience] Experience per tick (engine default).
   * @param {number} [settings.tickMs] Tick length (engine default).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      players: 100,
      days: 365,
      seed: 'simulation',
      channels: 27,
      luck: ENCOUNTER_CHANCE,
      encounterWeights: ENCOUNTER_WEIGHTS,
      levelRange: Encounter.LEVEL_RANGE,
      levelSpread: Encounter.LEVEL_SPREAD,
      levelOffset: LEVEL_OFFSET,
      levelOffsetMax: LEVEL_OFFSET_MAX,
      experienceRate: EXPERIENCE_RATE,
      tickMs: TICK_INTERVAL,
      perTickCapital: PER_TICK_CAPITAL,
      perTickExperience: PER_TICK_EXPERIENCE
    }, settings);
    this.ticksPerDay = DAY_MS / this.settings.tickMs;
    this.ticks = Math.floor(settings.ticks != null ? settings.ticks : this.settings.days * this.ticksPerDay);
  }

  /**
   * Simulate players `[from, to)` and return additive metrics.
   * @param {number} [from=0]
   * @param {number} [to=settings.players]
   * @returns {Object}
   */
  run (from = 0, to = this.settings.players) {
    const metrics = {
      players: 0,
      ticks: 0,
      encounters: 0,
      bands: {},
      levels: {},
      final: { level: 0, wealth: 0, kills: 0, max: 0, min: null }
    };
    for (let index = from; index < to; index++) this._player(index, metrics);
    return metrics;
  }

  _band (metrics, level) {
    const key = bandFor(level);
    if (!metrics.bands[key]) metrics.bands[key] = emptyBand();
    return metrics.bands[key];
  }

  _reached (metrics, from, to, tick) {
    for (let level = from + 1; level <= to; level++) {
      if (!metrics.levels[level]) metrics.levels[level] = { players: 0, ticks: 0 };
      metrics.levels[level].players += 1;
      metrics.levels[level].ticks += tick;
    }
  }

  // Ticks until (and including) the next encounter tick.
  _wait (rng) {
    const luck = this.settings.luck;
    if (luck >= 1) return 1;
    if (!(luck > 0)) return Infinity;
    return Math.floor(Math.log(1 - rng.next()) / Math.log(1 - luck)) + 1;
  }

  // Credit `n` idle ticks starting after `tick`, recording each level crossed
  // at the exact tick its experience is reached.
  _idle (player, metrics, tick, n) {
    const rate = this.settings.perTickExperience;
    player.ticks += n;
    player.presenceMs += n * this.settings.tickMs;
    player.wealth += n * this.settings.perTickCapital;
    this._band(metrics, player.level).idleExperience += n * rate;
    this._band(metrics, player.level).wealthEarned += n * this.settings.perTickCapital;

    let level = player.level;
    const end = player.experience + n * rate;
    while (rate > 0 && experienceForLevel(level + 1) <= end) {
      const at = tick + Math.max(1, Math.ceil((experienceForLevel(level + 1) - player.experience) / rate));
      this._reached(metrics, level, level + 1, at);
      level += 1;
    }
    player.gain(n * rate);
  }

  _player (index, metrics) {
    const settings = this.settings;
    const rng = seeded(`${settings.seed}:player:${index}`);
    const place = placeFor(`${settings.seed}:channel:${index % Math.max(1, settings.channels)}`);
    const player = new Player({ id: `simulation/users/${index}`, name: `pilot ${index}` });
    let tick = 0;

    while (tick < this.ticks) {
      const until = Math.min(this.ticks, tick + this._wait(rng));
      this._idle(player, metrics, tick, until - tick);
      tick = until;
      if (tick >= this.ticks) break;
      this._encounter(player, metrics, place, rng, tick);
    }

    metrics.players += 1;
    metrics.ticks += this.ticks;
    metrics.final.level += player.level;
    metrics.final.wealth += player.wealth;
    metrics.final.kills += player.kills;
    metrics.final.max = Math.max(metrics.final.max, player.level);
    metrics.final.min = metrics.final.min == null ? player.level : Math.min(metrics.final.min, player.level);
  }

  _encounter (player, metrics, place, rng, tick) {
    const before = player.level;
    const band = this._band(metrics, before);
    const outcome = new Encounter({
      actor: player.actor,
      place,
      weights: this.settings.encounterWeights,
      cacheMax: this.settings.perTickCapital * 5,
      levelRange: this.settings.levelRange,
      levelSpread: this.settings.levelSpread,
      levelOffset: this.settings.levelOffset,
      levelOffsetMax: this.settings.levelOffsetMax,
      experienceRate: this.settings.experienceRate,
      random: rng
    }).outcome;

    metrics.encounters += 1;
    band.encounters += 1;

    if (outcome.type === 'monster') {
      const fighter = Battle.fighter(player.actor);
      const weapon = player.equipment['main-hand'];
      band.monsters += 1;
      band.rounds += outcome.rounds;
      band.levelDelta += outcome.creature.level - before;
      band.damage += fighter.damage;
      band.health += fighter.maxHealth;
      band.armor += fighter.armor;
      band.weaponLevel += weapon ? (weapon.level || 1) : 0;
      if (outcome.rounds >= Battle.MAX_ROUNDS) band.timeouts += 1;
      if (outcome.victory) {
        band.wins += 1;
        band.killExperience += outcome.experience;
        band.healthLeft += outcome.health / outcome.maxHealth;
      } else {
        band.losses += 1;
      }
    }

    const found = outcome.type === 'item' ? [outcome.item] : (outcome.loot || []);
    for (const stack of found) {
      if (!items.isGear(items.get(stack.id))) continue;
      band.gear += 1;
      const rarity = items.rarity(stack);
      if (rarity === 'rare') band.rare += 1;
      if (rarity === 'legendary') band.legendary += 1;
    }
    if (outcome.type === 'blessing') band.blessingExperience += outcome.experience;
    if (outcome.type === 'cache') band.wealthEarned += outcome.wealth;

    const result = player.resolve(outcome);
    band.upgrades += result.equipped.length;
    band.wealthLost += result.lost;
    band.wealthEarned += result.sold;
    if (result.leveled) this._reached(metrics, before, result.level, tick);
  }

  /**
   * Readable rows from merged metrics.
   * @param {Object} metrics
   * @returns {{ summary: Object, bands: Array<Object>, milestones: Array<Object> }}
   */
  summarize (metrics) {
    const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
    const avg = (n, d, digits = 1) => (d ? Math.round((n / d) * Math.pow(10, digits)) / Math.pow(10, digits) : 0);
    const days = (ticks) => avg(ticks, this.ticksPerDay, 2);

    const bands = Object.keys(metrics.bands).map(Number).sort((a, b) => a - b).map((start) => {
      const b = metrics.bands[start];
      const experience = b.idleExperience + b.killExperience + b.blessingExperience;
      return {
        levels: start,
        encounters: b.encounters,
        winRate: pct(b.wins, b.monsters),
        rounds: avg(b.rounds, b.monsters),
        timeouts: pct(b.timeouts, b.monsters),
        healthLeft: pct(b.healthLeft, b.wins),
        levelDelta: avg(b.levelDelta, b.monsters, 2),
        killShare: pct(b.killExperience + b.blessingExperience, experience),
        upgrades: avg(100 * b.upgrades, b.encounters, 2),
        rare: pct(b.rare, b.gear),
        legendary: pct(b.legendary, b.gear),
        damage: avg(b.damage, b.monsters),
        health: avg(b.health, b.monsters),
        armor: avg(b.armor, b.monsters),
        weaponLevel: avg(b.weaponLevel, b.monsters),
        wealthLost: pct(b.wealthLost, b.wealthEarned)
      };
    });

    const reachedLevels = Object.keys(metrics.levels).map(Number).sort((a, b) => a - b);
    const top = reachedLevels.length ? reachedLevels[reachedLevels.length - 1] : 1;
    const milestones = [];
    for (let level = 2; level <= top; level = nextBand(level)) {
      const at = metrics.levels[level];
      const next = metrics.levels[level + 1];
      if (!at) continue;
      milestones.push({
        level,
        reached: pct(at.players, metrics.players),
        days: days(at.ticks / at.players),
        daysPerLevel: next && next.players === at.players ? days((next.ticks - at.ticks) / at.players) : null
      });
    }

    return {
      summary: {
        players: metrics.players,
        days: days(metrics.ticks / Math.max(1, metrics.players)),
        encounters: metrics.encounters,
        level: avg(metrics.final.level, metrics.players),
        maxLevel: metrics.final.max,
        minLevel: metrics.final.min,
        kills: avg(metrics.final.kills, metrics.players),
        wealth: avg(metrics.final.wealth, metrics.players, 0)
      },
      bands,
      milestones
    };
  }

  /**
   * A plain-text report.
   * @param {Object} metrics
   * @returns {string}
   */
  format (metrics) {
    const { summary, bands, milestones } = this.summarize(metrics);
    const lines = [];
    lines.push(`${summary.players} players x ${summary.days} days, ${summary.encounters} encounters`);
    lines.push(`final level avg ${summary.level} (min ${summary.minLevel}, max ${summary.maxLevel}), kills avg ${summary.kills}, wealth avg ${summary.wealth}`);
    lines.push('');
    lines.push(table(['levels', 'enc', 'win%', 'rounds', 'tmo%', 'hp%', 'lvlΔ', 'kill%', 'upg/100', 'rare%', 'leg%', 'dmg', 'hp', 'armor', 'wpnLvl', 'lost%'],
      bands.map((b) => [`${b.levels}+`, b.encounters, b.winRate, b.rounds, b.timeouts, b.healthLeft, b.levelDelta, b.killShare, b.upgrades, b.rare, b.legendary, b.damage, b.health, b.armor, b.weaponLevel, b.wealthLost])));
    lines.push('');
    lines.push(table(['level', 'reached%', 'day', 'days/level'],
      milestones.map((m) => [m.level, m.reached, m.days, m.daysPerLevel == null ? '-' : m.daysPerLevel])));
    return lines.join('\n');
  }
}

function nextBand (level) {
  const scale = Math.pow(10, Math.floor(Math.log10(level)));
  const step = level / scale;
  return step === 1 ? 2 * scale : (step === 2 ? 5 * scale : 10 * scale);
}

function table (head, rows) {
  const all = [head].concat(rows).map((row) => row.map(String));
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all.map((row) => row.map((cell, i) => cell.padStart(widths[i])).join('  ')).join('\n');
}

module.exports = Simulator;
module.exports.bandFor = bandFor;
module.exports.merge = merge;
