'use strict';

const PER_TICK_CAPITAL = 10;
const PER_TICK_EXPERIENCE = 10;
const TICK_INTERVAL = 600000;
const ENCOUNTER_CHANCE = 0.05;

// Level `n` requires LEVEL_BASE_EXPERIENCE * n ^ LEVEL_EXPONENT cumulative XP.
const LEVEL_BASE_EXPERIENCE = 100;
const LEVEL_EXPONENT = 1.5;

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
  LEVEL_BASE_EXPERIENCE,
  LEVEL_EXPONENT,
  PENALTY_COOLDOWN,
  PENALTY_FACTOR,
  RETENTION_DAYS,
  HTTP_HOST
};
