'use strict';

const attributes = require('@fabric/rpg/functions/attributes');
const bodies = require('@fabric/rpg/functions/bodies');
const items = require('@fabric/rpg/functions/items');
const { experienceFor, levelFor } = require('@fabric/rpg/functions/experience');

const {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  LEVEL_BASE_EXPERIENCE,
  LEVEL_EXPONENT,
  INVENTORY_SIZE,
  PENALTY_COOLDOWN,
  PENALTY_FACTOR
} = require('../constants');

// Each level grants one attribute point, in this order.
const GROWTH = ['strength', 'dexterity', 'constitution'];

// Players wear the humanoid kit; beast gear such as collars goes to the bag.
const BODY = 'humanoid';

// A lost battle costs this share of wealth.
const DEFEAT_FACTOR = 0.9;

const CURVE = { base: LEVEL_BASE_EXPERIENCE, exponent: LEVEL_EXPONENT };

/**
 * Level reached for a given amount of experience. Level 1 at 0 XP; level
 * `n + 1` takes `LEVEL_BASE_EXPERIENCE * n ^ LEVEL_EXPONENT` cumulative XP
 * (the `power` curve in `@fabric/rpg`).
 * @param {number} experience
 * @returns {number}
 */
function levelForExperience (experience) {
  return levelFor(experience, 'power', CURVE);
}

/**
 * Cumulative experience that reaches `level`.
 * @param {number} level
 * @returns {number}
 */
function experienceForLevel (level) {
  return experienceFor(level, 'power', CURVE);
}

function validStack (stack) {
  return !!(stack && typeof stack === 'object' && items.get(stack.id));
}

// Remote accounts as `{ service, id }`, dropping malformed and repeated ones.
function loadAccounts (accounts) {
  if (!Array.isArray(accounts)) return [];
  const seen = new Set();
  const list = [];
  for (const account of accounts) {
    if (!account || account.id == null || account.id === '') continue;
    const entry = { service: account.service ? String(account.service) : null, id: String(account.id) };
    const key = `${entry.service}\n${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(entry);
  }
  return list;
}

function loadStack (stack, level) {
  const copy = Object.assign({}, stack);
  if (copy.level == null && items.isGear(items.get(copy.id))) copy.level = level;
  return copy;
}

/**
 * Pure player record for IdleRPG. Holds the game-relevant numbers for one
 * player and the arithmetic that changes them; persistence and presence
 * tracking live in the engine. A player is reached through one or more
 * remote accounts on chat networks. Records saved before attributes and gear
 * existed load with the attribute points their level has earned, and gear
 * saved before item levels loads at the player's level.
 */
class Player {
  /**
   * @param {Object} [record]
   * @param {string} record.id Player id, assigned by the engine.
   * @param {string} [record.name] Display name; null until a host names the player.
   * @param {Array<Object>} [record.accounts] Remote accounts `{ service, id }`,
   *   e.g. `{ service: 'discord', id: '<snowflake>' }`.
   */
  constructor (record = {}) {
    this.id = record.id;
    this.name = record.name || null;
    this.accounts = loadAccounts(record.accounts);
    this.experience = Number(record.experience) || 0;
    this.wealth = Number(record.wealth) || 0;
    this.presenceMs = Number(record.presenceMs) || 0;
    this.ticks = Number(record.ticks) || 0;
    this.cooldown = Number(record.cooldown) || 0;
    this.attributes = attributes.normalize(record.attributes);
    this.allocated = record.attributes ? Math.max(1, Number(record.allocated) || 1) : 1;
    const level = this.level;
    this.equipment = {};
    for (const slot of bodies.slots(BODY)) {
      const stack = record.equipment && record.equipment[slot];
      if (validStack(stack) && items.get(stack.id).slot === slot) this.equipment[slot] = loadStack(stack, level);
    }
    this.inventory = Array.isArray(record.inventory) ? record.inventory.filter(validStack).map((stack) => loadStack(stack, level)) : [];
    this.kills = Number(record.kills) || 0;
    this.battles = {
      won: Number(record.battles && record.battles.won) || 0,
      lost: Number(record.battles && record.battles.lost) || 0
    };
    this.slain = Object.assign({}, record.slain || {});
    this.effects = Object.assign({}, record.effects || {});
    this.firstSeen = record.firstSeen || null;
    this.lastSeen = record.lastSeen || null;
    this._allocate();
  }

  get level () {
    return levelForExperience(this.experience);
  }

  /**
   * Main-hand weapon name, or `null` when fighting bare-handed.
   * @returns {string|null}
   */
  get weapon () {
    const stack = this.equipment['main-hand'];
    return stack ? items.displayName(stack) : null;
  }

  /**
   * Combatant for `@fabric/rpg` battles and encounters.
   * @returns {Object}
   */
  get actor () {
    return {
      name: this.name,
      level: this.level,
      body: BODY,
      attributes: this.attributes,
      equipment: this.equipment
    };
  }

  /**
   * Spend attribute points for every level not yet allocated.
   * @returns {Array<string>} Attributes raised.
   */
  _allocate () {
    const raised = [];
    while (this.allocated < this.level) {
      const name = GROWTH[(this.allocated - 1) % GROWTH.length];
      this.allocated += 1;
      this.attributes[name] += 1;
      raised.push(name);
    }
    return raised;
  }

  /**
   * Add experience.
   * @param {number} amount
   * @returns {{ leveled: boolean, level: number }}
   */
  gain (amount) {
    const before = this.level;
    this.experience += Math.max(0, Number(amount) || 0);
    const after = this.level;
    this._allocate();
    return { leveled: after > before, level: after };
  }

  /**
   * Credit one tick of presence.
   * @param {number} ms Milliseconds of presence credited.
   * @param {Object} [rates]
   * @returns {{ leveled: boolean, level: number }}
   */
  reward (ms, rates = {}) {
    this.presenceMs += Math.max(0, Number(ms) || 0);
    this.ticks += 1;
    this.wealth += rates.perTickCapital != null ? rates.perTickCapital : PER_TICK_CAPITAL;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - 1);
    return this.gain(rates.perTickExperience != null ? rates.perTickExperience : PER_TICK_EXPERIENCE);
  }

  /**
   * Take an item: better gear for a humanoid slot is equipped (the old piece
   * goes to the bag), everything else goes to the bag. A full bag sells its
   * cheapest pieces.
   * @param {Object} stack
   * @returns {{ equipped: Object|null, sold: number }}
   */
  receive (stack) {
    if (!validStack(stack)) return { equipped: null, sold: 0 };
    const def = items.get(stack.id);
    let equipped = null;
    let incoming = Object.assign({}, stack);

    if (items.canEquip(def, BODY)) {
      const current = this.equipment[def.slot];
      if (!current || items.gearScore(incoming) > items.gearScore(current)) {
        this.equipment[def.slot] = incoming;
        equipped = incoming;
        incoming = current || null;
      }
    }

    if (incoming) {
      const same = items.get(incoming.id).stackable && this.inventory.find((held) => held.id === incoming.id);
      if (same) same.count += incoming.count;
      else this.inventory.push(incoming);
    }

    let sold = 0;
    while (this.inventory.length > INVENTORY_SIZE) {
      let cheapest = 0;
      for (let i = 1; i < this.inventory.length; i++) {
        if (items.sellPrice(this.inventory[i]) < items.sellPrice(this.inventory[cheapest])) cheapest = i;
      }
      sold += items.sellPrice(this.inventory[cheapest]);
      this.inventory.splice(cheapest, 1);
    }
    this.wealth += sold;
    return { equipped, sold };
  }

  /**
   * Record a battle outcome.
   * @param {boolean} won
   * @param {string} [creature] Creature id slain on a win.
   * @returns {{ lost: number }} Wealth lost on defeat.
   */
  recordBattle (won, creature) {
    if (won) {
      this.battles.won += 1;
      this.kills += 1;
      if (creature) this.slain[creature] = (this.slain[creature] || 0) + 1;
      return { lost: 0 };
    }
    this.battles.lost += 1;
    const before = this.wealth;
    this.wealth = Math.floor(this.wealth * DEFEAT_FACTOR);
    return { lost: before - this.wealth };
  }

  /**
   * Apply an `@fabric/rpg` encounter outcome: a won battle records the kill,
   * takes the loot, then the experience; a lost one costs wealth; found gear
   * is taken; a blessing pays experience; a cache pays wealth.
   * @param {Object} outcome From `Encounter#outcome`.
   * @returns {{ lost: number, equipped: Array<Object>, sold: number, leveled: boolean, level: number }}
   */
  resolve (outcome) {
    const result = { lost: 0, equipped: [], sold: 0, leveled: false, level: this.level };
    const take = (stacks) => {
      for (const stack of stacks) {
        const received = this.receive(stack);
        if (received.equipped) result.equipped.push(received.equipped);
        result.sold += received.sold;
      }
    };

    switch (outcome.type) {
      case 'monster':
        if (!outcome.victory) {
          result.lost = this.recordBattle(false).lost;
          break;
        }
        this.recordBattle(true, outcome.creature.id);
        take(outcome.loot || []);
        Object.assign(result, this.gain(outcome.experience));
        break;
      case 'item':
        take([outcome.item]);
        break;
      case 'blessing':
        Object.assign(result, this.gain(outcome.experience));
        break;
      default:
        this.wealth += Number(outcome.wealth) || 0;
    }
    return result;
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
      accounts: this.accounts.map((account) => Object.assign({}, account)),
      experience: this.experience,
      wealth: this.wealth,
      presenceMs: this.presenceMs,
      ticks: this.ticks,
      cooldown: this.cooldown,
      attributes: this.attributes,
      allocated: this.allocated,
      equipment: this.equipment,
      inventory: this.inventory,
      kills: this.kills,
      battles: this.battles,
      slain: this.slain,
      effects: this.effects,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      level: this.level
    };
  }
}

module.exports = Player;
module.exports.experienceForLevel = experienceForLevel;
module.exports.levelForExperience = levelForExperience;
module.exports.BODY = BODY;
module.exports.DEFEAT_FACTOR = DEFEAT_FACTOR;
module.exports.GROWTH = GROWTH;
