'use strict';

const {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  LEVEL_BASE_EXPERIENCE,
  LEVEL_EXPONENT,
  PENALTY_COOLDOWN,
  PENALTY_FACTOR
} = require('../constants');

/**
 * Level reached for a given amount of experience. Level 1 at 0 XP; each
 * level costs `LEVEL_BASE_EXPERIENCE * level ^ LEVEL_EXPONENT` cumulative XP.
 * @param {number} experience
 * @returns {number}
 */
function levelForExperience (experience) {
  const xp = Math.max(0, Number(experience) || 0);
  let level = 1;
  while (xp >= LEVEL_BASE_EXPERIENCE * Math.pow(level, LEVEL_EXPONENT)) level += 1;
  return level;
}

/**
 * Pure player record for IdleRPG. Holds the game-relevant numbers for one
 * user and the arithmetic that changes them; persistence and presence
 * tracking live in the engine.
 */
class Player {
  /**
   * @param {Object} [record]
   * @param {string} record.id Namespaced user id (`<service>/users/<id>`).
   * @param {string} [record.name]
   */
  constructor (record = {}) {
    this.id = record.id;
    this.name = record.name || record.id;
    this.experience = Number(record.experience) || 0;
    this.wealth = Number(record.wealth) || 0;
    this.presenceMs = Number(record.presenceMs) || 0;
    this.ticks = Number(record.ticks) || 0;
    this.cooldown = Number(record.cooldown) || 0;
    this.inventory = Array.isArray(record.inventory) ? record.inventory.slice() : [];
    this.effects = Object.assign({}, record.effects || {});
    this.firstSeen = record.firstSeen || null;
    this.lastSeen = record.lastSeen || null;
  }

  get level () {
    return levelForExperience(this.experience);
  }

  /**
   * Credit one tick of presence.
   * @param {number} ms Milliseconds of presence credited.
   * @param {Object} [rates]
   * @returns {{ leveled: boolean, level: number }}
   */
  reward (ms, rates = {}) {
    const before = this.level;
    this.presenceMs += Math.max(0, Number(ms) || 0);
    this.ticks += 1;
    this.wealth += rates.perTickCapital != null ? rates.perTickCapital : PER_TICK_CAPITAL;
    this.experience += rates.perTickExperience != null ? rates.perTickExperience : PER_TICK_EXPERIENCE;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - 1);
    const after = this.level;
    return { leveled: after > before, level: after };
  }

  /**
   * Slash wealth for breaking the silence rule.
   * @returns {{ notify: boolean }}
   */
  penalize () {
    const notify = this.cooldown === 0;
    this.cooldown = PENALTY_COOLDOWN;
    this.wealth = Math.floor(this.wealth * PENALTY_FACTOR);
    return { notify };
  }

  toObject () {
    return {
      id: this.id,
      name: this.name,
      experience: this.experience,
      wealth: this.wealth,
      presenceMs: this.presenceMs,
      ticks: this.ticks,
      cooldown: this.cooldown,
      inventory: this.inventory,
      effects: this.effects,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      level: this.level
    };
  }
}

module.exports = Player;
module.exports.levelForExperience = levelForExperience;
