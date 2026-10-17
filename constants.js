'use strict';

// The world tick shared with @fabric/rpg (10 minutes).
const { TICK_INTERVAL } = require('@fabric/rpg/constants');

const PER_TICK_CAPITAL = 10;
const PER_TICK_EXPERIENCE = 10;
const ENCOUNTER_CHANCE = 0.05;

// What an encounter is, by relative weight.
const ENCOUNTER_WEIGHTS = { monster: 6, item: 2, cache: 1, blessing: 1 };

// Multiplier on @fabric/rpg kill and blessing experience.
const EXPERIENCE_RATE = 1;

// Monsters are centered LEVEL_OFFSET of the player's level above it, at most
// LEVEL_OFFSET_MAX levels, so fights stay close while players gather gear at
// this pace.
const LEVEL_OFFSET = 0.1;
const LEVEL_OFFSET_MAX = 15;

// Inventory slots; full bags sell the cheapest piece.
const INVENTORY_SIZE = 16;

// Level `n + 1` requires LEVEL_BASE_EXPERIENCE * n ^ LEVEL_EXPONENT cumulative
// XP. The exponent sets the pace: level 100 after about three months of
// continuous presence (`npm run simulate`).
const LEVEL_BASE_EXPERIENCE = 100;
const LEVEL_EXPONENT = 1.65;

// Chat in a game channel slashes wealth and starts a cooldown (in ticks).
const PENALTY_COOLDOWN = 10;
const PENALTY_FACTOR = 0.5;

// Day buckets kept; 0 keeps every day ever recorded.
const RETENTION_DAYS = 0;

const HTTP_HOST = 'api.roleplaygateway.com';

module.exports = {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  TICK_INTERVAL,
  ENCOUNTER_CHANCE,
  ENCOUNTER_WEIGHTS,
  EXPERIENCE_RATE,
  INVENTORY_SIZE,
  LEVEL_BASE_EXPERIENCE,
  LEVEL_EXPONENT,
  LEVEL_OFFSET,
  LEVEL_OFFSET_MAX,
  PENALTY_COOLDOWN,
  PENALTY_FACTOR,
  RETENTION_DAYS,
  HTTP_HOST
};
