'use strict';

// ## IdleRPG
// A game which rewards participants for remaining present (and idle). The
// engine is a `@fabric/core` Service: it owns the game state, persists it in
// a Fabric Store, and exposes a small input API (`_registerUser`,
// `_handleJoin`, `_handlePart`, `_handlePresence`, `_handleMessage`) that any
// host — Doorman, a test, a script — drives. Nothing here speaks to a chat
// network directly; see `services/idlerpg.js` for the Doorman adapter.
//
// The world comes from `@fabric/rpg`: the clock is its
// `WorldClock`, encounters are its seeded `Encounter` (creatures, battles,
// loot), and each game channel is a named place with a biome.

const crypto = require('crypto');
const Message = require('@fabric/core/types/message');
const Service = require('@fabric/core/types/service');
const WorldClock = require('@fabric/rpg/types/clock');
const Encounter = require('@fabric/rpg/types/encounter');
const bodies = require('@fabric/rpg/functions/bodies');
const creatures = require('@fabric/rpg/functions/creatures');
const items = require('@fabric/rpg/functions/items');
const { placeFor } = require('@fabric/rpg/functions/places');
const { seeded } = require('@fabric/rpg/functions/random');
const Player = require('./player');

const {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  TICK_INTERVAL,
  ENCOUNTER_CHANCE,
  ENCOUNTER_WEIGHTS,
  EXPERIENCE_RATE,
  LEVEL_OFFSET,
  LEVEL_OFFSET_MAX,
  PRESENCE_SOURCES,
  RETENTION_DAYS,
  TEXT_PRESENCE_MS
} = require('../constants');

const STORE_KEY = '/idlerpg';
const UNKNOWN_NAME = 'Unknown pilot';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOP_CREATURES = 5;
const PLAYER_ID_BYTES = 8;

/**
 * The remote account behind a namespaced user id: `<service>/users/<id>`
 * becomes `{ service, id }`; anything else is kept whole with no service.
 * @param {string} key
 * @returns {{ service: string|null, id: string }}
 */
function accountOf (key) {
  const match = /^([^/]+)\/users\/(.+)$/.exec(String(key));
  return match ? { service: match[1], id: match[2] } : { service: null, id: String(key) };
}

/**
 * Namespaced user id of a remote account (the inverse of `accountOf`).
 * @param {{ service: string|null, id: string }} account
 * @returns {string}
 */
function accountKey (account) {
  return account.service ? `${account.service}/users/${account.id}` : account.id;
}

function dayKey (ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowDays (now, days) {
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(now - i * DAY_MS));
  return keys;
}

function round1 (n) {
  return Math.round(n * 10) / 10;
}

function article (name) {
  if (/s$/i.test(name)) return name;
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
}

// Rare gear (one affix) is bold; legendary gear (prefix and suffix) is also labelled.
function itemName (stack) {
  const name = items.displayName(stack);
  switch (items.rarity(stack)) {
    case 'legendary': return `**${name}** (legendary)`;
    case 'rare': return `**${name}**`;
    default: return name;
  }
}

function itemPhrase (stack) {
  const a = items.article(stack);
  return a ? `${a} ${itemName(stack)}` : itemName(stack);
}

function listItems (stacks) {
  return stacks.map(itemName).join(', ');
}

// Announcement tail for gear equipped and spares sold by `Player#resolve`.
function receipt (result) {
  let text = '';
  if (result.equipped.length) text += `  Equipped: ${result.equipped.map(itemName).join(', ')}.`;
  if (result.sold) text += `  Sold spares for **${result.sold}** gold.`;
  return text;
}

/**
 * Generic IdleRPG engine.
 * @fires IdleRPG#tick Once per clock cycle with `{ clock, presentNow, now }`.
 * @fires IdleRPG#message Announcements `{ actor, object, target }` for the host to deliver.
 * @fires IdleRPG#whisper Private notices `{ target, object }`.
 */
class IdleRPG extends Service {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.name='idlerpg']
   * @param {string} [settings.path='stores/idlerpg'] Store directory.
   * @param {boolean} [settings.persistent=true] Persist state to the Store.
   * @param {number} [settings.interval=600000] Tick interval in milliseconds (`tickMs` alias);
   *   defaults to the `@fabric/rpg` world tick.
   * @param {number} [settings.luck=0.05] Encounter chance per rewarded tick (0-1).
   * @param {Object} [settings.encounterWeights] Relative weights of `monster`,
   *   `item`, `cache`, and `blessing` encounters (default 6, 2, 1, 1).
   * @param {number} [settings.levelRange=2] Monsters are at least the player's level ± this many...
   * @param {number} [settings.levelSpread=0.1] ...or ± this fraction of it, when wider.
   * @param {number} [settings.levelOffset] Monsters are centered this fraction of the player's level above it...
   * @param {number} [settings.levelOffsetMax] ...but at most this many levels.
   * @param {number} [settings.experienceRate] Multiplier on kill and blessing experience.
   * @param {number} [settings.perTickExperience] Experience per tick present.
   * @param {string} [settings.seed] World seed for encounters; generated and saved on first start.
   * @param {Array<string>} [settings.sources=['channel','status']] What makes a
   *   player present: `channel` (in an allowed channel, from `join` / `part` /
   *   `presence` naming one — voice channels on Discord, rooms on IRC or
   *   Matrix), `status` (online with no channel, from `presence` or a `user`
   *   marked online), and `text` (a message in an allowed channel, for
   *   `textWindowMs` afterwards; such messages are not penalized).
   * @param {number} [settings.textWindowMs=1800000] How long a message keeps its author present.
   * @param {Array<string>} [settings.channels=[]] Channel allowlist (empty = every channel counts).
   * @param {Array<string>} [settings.announcements=[]] Fully qualified targets
   *   (`<service>/channels/<id>`) that receive every announcement instead of the
   *   presence channels. When set, chatting there — and nowhere else — is penalized.
   * @param {boolean} [settings.penalties=true] Slash wealth for chatting in the
   *   announcement channels, or in a game channel when there are none.
   * @param {boolean} [settings.autostart=true] Run the tick clock on `start()`.
   * @param {number} [settings.retentionDays=0] Day buckets kept (0 = keep all history).
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    const { interval, tickMs, ...rest } = settings;
    super(Object.assign({
      name: 'idlerpg',
      path: 'stores/idlerpg',
      persistent: true,
      networking: false
    }, rest));

    this.settings = Object.assign({
      alias: 'idlerpg',
      sources: PRESENCE_SOURCES,
      textWindowMs: TEXT_PRESENCE_MS,
      channels: [],
      announcements: [],
      luck: ENCOUNTER_CHANCE,
      encounterWeights: ENCOUNTER_WEIGHTS,
      levelRange: Encounter.LEVEL_RANGE,
      levelSpread: Encounter.LEVEL_SPREAD,
      levelOffset: LEVEL_OFFSET,
      levelOffsetMax: LEVEL_OFFSET_MAX,
      experienceRate: EXPERIENCE_RATE,
      perTickCapital: PER_TICK_CAPITAL,
      perTickExperience: PER_TICK_EXPERIENCE,
      penalties: true,
      autostart: true,
      retentionDays: RETENTION_DAYS,
      now: () => Date.now()
    }, this.settings, rest, {
      tickMs: Number(tickMs != null ? tickMs : (interval != null ? interval : TICK_INTERVAL))
    });

    this._state.content = {
      users: {},
      players: {},
      channels: {},
      stats: { totalPresentMs: 0, totalTicks: 0, days: {}, lastTick: null, startedAt: null, seed: null, playerIds: 0, battles: { won: 0, lost: 0 }, slain: {} }
    };
    // Namespaced user id (`<service>/users/<id>`) → player id, rebuilt from the players' accounts.
    this._accounts = {};

    this.worldClock = new WorldClock({ interval: this.settings.tickMs, now: this.settings.now });
    this.worldClock.on('tick', () => {
      this.tick().catch((error) => this.emit('error', `[IDLERPG] tick: ${error && error.message ? error.message : error}`));
    });
    this._dirty = false;

    // Command handlers exposed to hosts (Doorman maps these to `!triggers`).
    this.triggers = {
      online: { name: 'online', value: this._handleOnlineRequest.bind(this) },
      memberlist: { name: 'memberlist', value: this._handleMemberlistRequest.bind(this) },
      profile: { name: 'profile', value: this._handleProfileRequest.bind(this) },
      leaderboard: { name: 'leaderboard', value: this._handleLeaderboardRequest.bind(this) },
      balance: { name: 'balance', value: this._handleBalanceRequest.bind(this) },
      transfer: { name: 'transfer', value: this._handleTransferRequest.bind(this) }
    };

    return this;
  }

  get content () {
    return this._state.content;
  }

  get now () {
    return this.settings.now();
  }

  // ### Lifecycle

  async start () {
    await super.start();
    await this._restore();
    const stats = this.content.stats;
    if (!stats.startedAt) stats.startedAt = new Date(this.now).toISOString();
    if (this.settings.seed != null) stats.seed = String(this.settings.seed);
    if (!stats.seed) stats.seed = crypto.randomBytes(16).toString('hex');
    this._migratePlayers();
    this.worldClock.clock = stats.totalTicks;
    if (this.settings.autostart && this.settings.tickMs > 0) this.worldClock.start();
    this.emit('ready');
    return this;
  }

  async stop () {
    this.worldClock.stop();
    await this._persist();
    await super.stop();
    return this;
  }

  async _restore () {
    if (!this.store) return;
    let prior = null;
    try { prior = await this.store.get(STORE_KEY); } catch (_) { prior = null; }
    if (typeof prior === 'string') {
      try { prior = JSON.parse(prior); } catch (_) { prior = null; }
    }
    if (!prior || typeof prior !== 'object') return;
    const content = this.content;
    content.users = prior.users || {};
    content.players = prior.players || {};
    content.channels = prior.channels || {};
    content.stats = Object.assign(content.stats, prior.stats || {});
    if (!content.stats.days) content.stats.days = {};
    if (!content.stats.battles) content.stats.battles = { won: 0, lost: 0 };
    if (!content.stats.slain) content.stats.slain = {};
    // Nobody is known to be present after a restart until the host says so.
    for (const user of Object.values(content.users)) {
      user.presence = 'offline';
      user.status = 'offline';
      user.channels = {};
      user.spokeAt = null;
    }
  }

  async _persist () {
    if (!this.store || !this.store.db) return;
    this._dirty = false;
    try {
      await this.store.set(STORE_KEY, this.content);
    } catch (error) {
      this.emit('error', `[IDLERPG] persist: ${error && error.message ? error.message : error}`);
    }
  }

  /**
   * Bring every player record up to date and index their remote accounts.
   * Saves from before remote accounts kept each player under its namespaced
   * user id (`discord/users/<id>`); such a record moves to a player id of its
   * own with that account as its first, and keeps everything it tracked —
   * experience, gear, battles, history, and the day buckets that counted it.
   * Older saves also predate attributes and gear; `Player` fills them in.
   */
  _migratePlayers () {
    const content = this.content;
    const players = {};
    const legacy = [];
    for (const [key, record] of Object.entries(content.players || {})) {
      if (!record || typeof record !== 'object') continue;
      if (Array.isArray(record.accounts) && record.accounts.length && record.id) players[record.id] = record;
      else legacy.push({ key: record.id || key, record });
    }
    const taken = new Set(Object.keys(players));
    for (const { key, record } of legacy) {
      const id = this._newPlayerId(taken);
      taken.add(id);
      players[id] = Object.assign({}, record, {
        id,
        name: record.name && record.name !== key ? record.name : null,
        accounts: [accountOf(key)]
      });
    }
    content.players = {};
    this._accounts = {};
    for (const record of Object.values(players)) {
      const player = new Player(record).toObject();
      content.players[player.id] = player;
      for (const account of player.accounts) {
        const key = accountKey(account);
        if (!this._accounts[key]) this._accounts[key] = player.id;
      }
    }
    if (!legacy.length) return;
    for (const bucket of Object.values(content.stats.days || {})) {
      const counted = {};
      for (const key of Object.keys(bucket.players || {})) counted[this._accounts[key] || key] = 1;
      bucket.players = counted;
    }
    this._dirty = true;
  }

  /**
   * A new player id: a hash of the private world seed and a count of ids
   * issued, so it reveals nothing about the player's accounts and a seeded
   * world replays the same ids.
   * @param {Set<string>} [taken] Ids already in use.
   * @returns {string}
   */
  _newPlayerId (taken = new Set(Object.keys(this.content.players))) {
    const stats = this.content.stats;
    let id;
    do {
      stats.playerIds = (stats.playerIds || 0) + 1;
      const source = stats.seed ? `${stats.seed}:player:${stats.playerIds}` : crypto.randomBytes(16);
      id = crypto.createHash('sha256').update(source).digest('hex').slice(0, PLAYER_ID_BYTES * 2);
    } while (taken.has(id));
    return id;
  }

  // ### Clock

  /**
   * Service heartbeat with a summary instead of the whole game: players with
   * gear, bags, and daily history outgrow the 32 KiB wire Message limit the
   * core beat checks against. The full state lives in the Store.
   * @emits Message#beat
   * @returns {IdleRPG}
   */
  beat () {
    ++this._clock;
    const stats = this.content.stats;
    const beat = Message.fromVector(['Generic', {
      clock: this._clock,
      created: new Date(this.now).toISOString(),
      state: {
        players: Object.keys(this.content.players).length,
        present: this._presentPlayerIds().size,
        totalTicks: stats.totalTicks,
        lastTick: stats.lastTick
      }
    }]);
    this.emit('beat', beat);
    this.commit();
    return this;
  }

  /**
   * One clock cycle: every present player is credited `tickMs` of presence
   * plus the per-tick rewards; global and per-day statistics are updated.
   * @returns {Promise<IdleRPG>}
   */
  async tick () {
    const now = this.now;
    const day = dayKey(now);
    const stats = this.content.stats;
    const bucket = this._bucket(day);
    for (const user of Object.values(this.content.users)) {
      if (user.presence === 'online' && !this._isPresent(user)) {
        user.presence = 'offline';
        user.since = null;
      }
    }
    const credited = new Set();

    // A player present on several accounts is credited once.
    for (const user of this._presentUsers()) {
      const player = this._player(user.id, user.name);
      if (credited.has(player.id)) continue;
      credited.add(player.id);
      const record = new Player(player);
      const outcome = record.reward(this.settings.tickMs, this.settings);
      record.lastSeen = new Date(now).toISOString();
      bucket.presentMs += this.settings.tickMs;
      bucket.players[player.id] = 1;
      stats.totalPresentMs += this.settings.tickMs;
      if (outcome.leveled) this.announce(`${this._publicName(record)} has reached level ${outcome.level}!`);
      this._rollForEncounter(record, user);
      Object.assign(player, record.toObject());
    }

    bucket.ticks += 1;
    bucket.peak = Math.max(bucket.peak, credited.size);
    stats.totalTicks += 1;
    this.worldClock.clock = stats.totalTicks;
    stats.lastTick = new Date(now).toISOString();
    this._pruneDays(now);

    await this._persist();
    this.emit('tick', { clock: stats.totalTicks, presentNow: credited.size, now });
    return this;
  }

  _bucket (day) {
    const days = this.content.stats.days;
    if (!days[day]) days[day] = { presentMs: 0, peak: 0, ticks: 0, players: {} };
    return days[day];
  }

  _pruneDays (now) {
    const retentionDays = Number(this.settings.retentionDays);
    if (!(retentionDays > 0)) return;
    const oldest = dayKey(now - (retentionDays - 1) * DAY_MS);
    for (const key of Object.keys(this.content.stats.days)) {
      if (key < oldest) delete this.content.stats.days[key];
    }
  }

  /**
   * Where a present user is: the place named after the first game channel
   * they are in, else the channel they last spoke in (or the game itself for
   * channel-less adapters).
   * @param {Object} [user]
   * @returns {Object} `@fabric/rpg` place `{ key, name, kind, biome }`.
   */
  _placeFor (user) {
    const channels = user && user.channels ? Object.keys(user.channels).sort() : [];
    return placeFor(channels[0] || (user && user.spokeIn) || this.settings.alias);
  }

  /**
   * Maybe meet something this tick. The roll is seeded by the world seed,
   * the tick, and the player, so a saved world replays the same encounters.
   * @param {Player} player Mutated in place.
   * @param {Object} [user]
   * @returns {Object|null} The encounter outcome.
   */
  _rollForEncounter (player, user) {
    const stats = this.content.stats;
    const random = seeded(`${stats.seed}:${stats.totalTicks}:${player.id}`);
    if (!random.chance(this.settings.luck)) return null;
    const place = this._placeFor(user);
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
      random
    }).outcome;
    this._applyEncounter(player, outcome);
    return outcome;
  }

  _applyEncounter (player, outcome) {
    const name = this._publicName(player);
    const near = outcome.place ? ` near ${outcome.place.name}` : '';
    const stats = this.content.stats;
    const result = player.resolve(outcome);
    const received = receipt(result);

    switch (outcome.type) {
      case 'monster': {
        const foe = `level ${outcome.creature.level} ${outcome.creature.name}`;
        if (!outcome.victory) {
          stats.battles.lost += 1;
          this.announce(`${name} was defeated by ${article(foe)}${near}${result.lost ? ` and dropped **${result.lost}** gold` : ''}.`);
          break;
        }
        stats.battles.won += 1;
        stats.slain[outcome.creature.id] = (stats.slain[outcome.creature.id] || 0) + 1;
        const verb = outcome.creature.hostile ? 'slew' : 'hunted';
        const loot = outcome.loot.length ? `, looting ${listItems(outcome.loot)}` : '';
        this.announce(`${name} ${verb} ${article(foe)}${near} for **${outcome.experience}** experience${loot}.${received}`);
        break;
      }
      case 'item':
        this.announce(`${name} found ${itemPhrase(outcome.item)}${near}.${received}`);
        break;
      case 'blessing':
        this.announce(`${outcome.deity} smiled upon ${name}${near}: **${outcome.experience}** experience.`);
        break;
      default:
        this.announce(`${name} stumbled upon a hidden cache in their travels${near} and looted **${outcome.wealth}** gold.`);
    }
    if (result.leveled) this.announce(`${name} has reached level ${result.level}!`);
    this._dirty = true;
  }

  // ### Inputs

  _channelAllowed (channel) {
    const list = this.settings.channels || [];
    if (!list.length) return true;
    if (!channel) return false;
    const leaf = String(channel).split('/').pop().toLowerCase();
    return list.some((entry) => {
      const wanted = String(entry).toLowerCase();
      return wanted === String(channel).toLowerCase() || wanted === leaf || wanted === `#${leaf}`;
    });
  }

  _user (id, name) {
    const users = this.content.users;
    if (!users[id]) {
      users[id] = { id, name: name || id, presence: 'offline', channels: {}, since: null };
    } else if (name && users[id].name !== name) {
      users[id].name = name;
    }
    const player = this._playerOf(id);
    if (name && name !== id && player && player.name !== name) {
      player.name = name;
      this._dirty = true;
    }
    return users[id];
  }

  /**
   * The player reached through a remote account, or null.
   * @param {string} key Namespaced user id (`<service>/users/<id>`).
   * @returns {Object|null} Stored player record.
   */
  playerFor (key) {
    return this._playerOf(key);
  }

  /**
   * Attach another remote account to the player behind `key` — the same
   * person on a second chat network, say. Refused when that account already
   * belongs to another player.
   * @param {string} key Namespaced user id of an account the player has (or will have).
   * @param {string} other Namespaced user id of the account to attach.
   * @returns {Object|null} The player, or null when refused.
   */
  linkAccount (key, other) {
    const owner = this._playerOf(other);
    const known = this._playerOf(key);
    if (owner) return known && owner.id === known.id ? known : null;
    const player = known || this._player(key);
    player.accounts.push(accountOf(other));
    this._accounts[other] = player.id;
    this._dirty = true;
    return player;
  }

  _playerOf (key) {
    const id = key == null ? null : this._accounts[key];
    return id ? this.content.players[id] || null : null;
  }

  /**
   * The player for a remote account, created on first sight with that
   * account as their first.
   * @param {string} key Namespaced user id (`<service>/users/<id>`).
   * @param {string} [name] Display name; ignored when it is just the id.
   * @returns {Object} Stored player record.
   */
  _player (key, name) {
    const known = name && name !== key ? name : null;
    let player = this._playerOf(key);
    if (!player) {
      const id = this._newPlayerId();
      player = new Player({ id, name: known, accounts: [accountOf(key)], firstSeen: new Date(this.now).toISOString() }).toObject();
      this.content.players[id] = player;
      this._accounts[key] = id;
      this._dirty = true;
    } else if (known && player.name !== known) {
      player.name = known;
      this._dirty = true;
    }
    return player;
  }

  _isBot (record) {
    return (record.accounts || []).some((account) => accountKey(account) === this.settings.alias);
  }

  _sources () {
    return new Set([].concat(this.settings.sources || []).map((source) => String(source).toLowerCase()));
  }

  /**
   * Whether a user counts as present under the configured `sources`.
   * @param {Object} user
   * @returns {boolean}
   */
  _isPresent (user) {
    if (!user || user.id === this.settings.alias) return false;
    const sources = this._sources();
    if (sources.has('channel') && Object.keys(user.channels || {}).length) return true;
    if (sources.has('status') && user.status === 'online') return true;
    return sources.has('text') && user.spokeAt != null && this.now - user.spokeAt < this.settings.textWindowMs;
  }

  _presentUsers () {
    return Object.values(this.content.users).filter((user) => this._isPresent(user));
  }

  // Players present now, however many of their accounts are.
  _presentPlayerIds () {
    return new Set(this._presentUsers().map((user) => this._accounts[user.id] || user.id));
  }

  /**
   * Record whether a user is present now; welcome first-time players.
   * Callers must not await before this: `wasPresent` is read synchronously so a
   * concurrent join + presence for the same user cannot both welcome them.
   * @param {Object} user
   * @param {boolean} wasPresent
   */
  async _settle (user, wasPresent) {
    const present = this._isPresent(user);
    user.presence = present ? 'online' : 'offline';
    this._dirty = true;
    if (!present) {
      user.since = null;
      return user;
    }
    if (!wasPresent) {
      user.since = this.now;
      const player = this._player(user.id, user.name);
      if (!player.ticks) await this._welcomePlayer(player);
    }
    return user;
  }

  /**
   * @param {Object} user `{ id, name?, online? }`
   */
  async _registerUser (user) {
    if (!user || !user.id) return null;
    const record = this._user(user.id, user.name);
    if (user.online === true || user.presence === 'online') await this._handlePresence({ user: user.id, status: 'online' });
    this._dirty = true;
    return record;
  }

  async _registerChannel (channel) {
    return this._channel(channel);
  }

  _channel (channel) {
    if (!channel || !channel.id) return null;
    const channels = this.content.channels;
    if (!channels[channel.id]) channels[channel.id] = { id: channel.id, name: channel.name || channel.id, members: {} };
    this._dirty = true;
    return channels[channel.id];
  }

  /**
   * Name safe to publish: never a service id.
   * @param {Object} player
   * @returns {string}
   */
  _publicName (player) {
    return player.name || UNKNOWN_NAME;
  }

  /**
   * @param {Object} join `{ user, channel }`
   */
  async _handleJoin (join) {
    if (!join || !join.user) return null;
    return this._handlePresence({ user: join.user, status: 'online', channel: join.channel });
  }

  /**
   * @param {Object} part `{ user, channel }`
   */
  async _handlePart (part) {
    if (!part || !part.user) return null;
    return this._handlePresence({ user: part.user, status: 'offline', channel: part.channel });
  }

  /**
   * Presence change. With the `channel` source a user is present while in at
   * least one allowed channel; with `status`, while online with no channel.
   * Going offline with no channel leaves every channel.
   * @param {Object} presence `{ user, status: 'online'|'offline', channel? }`
   */
  async _handlePresence (presence) {
    if (!presence || !presence.user) return null;
    const user = this._user(presence.user);
    const channel = presence.channel || null;
    const sources = this._sources();
    const wasPresent = this._isPresent(user);

    if (presence.status === 'online') {
      if (channel) {
        if (!sources.has('channel') || !this._channelAllowed(channel)) return user;
        this._channel({ id: channel });
        this.content.channels[channel].members[user.id] = 1;
        user.channels[channel] = 1;
      } else {
        if (!sources.has('status') || !this._channelAllowed(null)) return user;
        user.status = 'online';
      }
    } else if (channel) {
      delete user.channels[channel];
      if (this.content.channels[channel]) delete this.content.channels[channel].members[user.id];
    } else {
      for (const id of Object.keys(user.channels)) {
        if (this.content.channels[id]) delete this.content.channels[id].members[user.id];
      }
      user.channels = {};
      user.status = 'offline';
    }

    return this._settle(user, wasPresent);
  }

  /**
   * A message. With the `text` source, a message in an allowed channel keeps
   * its author present for `textWindowMs`. Otherwise chat breaks the
   * silence rule only where the game is announced: in the announcement
   * channels when any are configured, else in the game channels.
   * @param {Object} message `{ actor, target, object }`
   */
  async _handleMessage (message) {
    if (!message || !message.actor || !message.target) return null;
    if (typeof message.object === 'string' && message.object.trim().startsWith('!')) return null;
    if (this._sources().has('text') && this._channelAllowed(message.target)) {
      const user = this._user(message.actor);
      const wasPresent = this._isPresent(user);
      user.spokeAt = this.now;
      user.spokeIn = message.target;
      return this._settle(user, wasPresent);
    }
    if (!this._penalizedIn(message.target)) return null;
    const player = this._playerOf(message.actor);
    if (!player) return null;
    const record = new Player(player);
    const { notify } = record.penalize();
    Object.assign(player, record.toObject());
    this._dirty = true;
    if (notify) this.announce(`${this._publicName(player)} has disrupted the peace!  Penalties have been applied, but life goes on.`);
    return player;
  }

  /**
   * Whether chatting in `target` breaks the silence rule. With announcement
   * channels configured only those count, so voice channels' text chat and
   * every other channel a player happens to be present in stay free.
   * @param {string} target
   * @returns {boolean}
   */
  _penalizedIn (target) {
    if (!this.settings.penalties || !target) return false;
    const announcements = this._announcementTargets();
    if (announcements.length) return announcements.includes(target);
    return !!this.content.channels[target] && this._channelAllowed(target);
  }

  async _welcomePlayer (player) {
    this.announce(`Welcome to IdleRPG, ${this._publicName(player)}.  The one rule — _no talking in this channel_ — is now in effect.  **Violators will be slashed.**  Best of luck!`);
  }

  _announcementTargets () {
    return (this.settings.announcements || []).map((target) => String(target).trim()).filter(Boolean);
  }

  /**
   * Emit an announcement to the configured announcement targets, or to every
   * known game channel when none are configured.
   * @param {string} text
   */
  announce (text) {
    const fixed = this._announcementTargets();
    const targets = fixed.length ? fixed : Object.keys(this.content.channels);
    for (const target of targets) {
      this.emit('message', { actor: this.settings.alias, object: text, target });
    }
  }

  // ### Reports

  /**
   * Aggregate presence statistics — never user ids.
   * @returns {Object}
   */
  report () {
    const now = this.now;
    const stats = this.content.stats;
    const window = (days) => {
      const keys = windowDays(now, days);
      const players = new Set();
      let presentMs = 0;
      let peak = 0;
      for (const key of keys) {
        const bucket = stats.days[key];
        if (!bucket) continue;
        presentMs += bucket.presentMs;
        peak = Math.max(peak, bucket.peak);
        for (const id of Object.keys(bucket.players)) players.add(id);
      }
      return { hours: round1(presentMs / HOUR_MS), players: players.size, peak };
    };
    const players = Object.values(this.content.players);
    const levels = {};
    for (const player of players) {
      const level = new Player(player).level;
      levels[level] = (levels[level] || 0) + 1;
    }
    const battles = stats.battles || { won: 0, lost: 0 };
    const slain = Object.entries(stats.slain || {})
      .map(([id, count]) => {
        const creature = creatures.get(id);
        return { id, name: creature ? creature.name : id, count };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, TOP_CREATURES);
    return {
      generatedAt: new Date(now).toISOString(),
      presentNow: this._presentPlayerIds().size,
      uniquePlayers: players.length,
      totalPresentHours: round1(stats.totalPresentMs / HOUR_MS),
      totalTicks: stats.totalTicks,
      tickMs: this.settings.tickMs,
      lastTick: stats.lastTick,
      startedAt: stats.startedAt,
      last7Days: window(7),
      last30Days: window(30),
      battles: { won: battles.won, lost: battles.lost, total: battles.won + battles.lost },
      kills: battles.won,
      slain,
      levels,
      history: windowDays(now, 30).reverse().map((day) => {
        const bucket = stats.days[day] || { presentMs: 0, peak: 0, players: {} };
        return { day, hours: round1(bucket.presentMs / HOUR_MS), players: Object.keys(bucket.players).length, peak: bucket.peak };
      })
    };
  }

  /**
   * Public leaderboard: player ids, display names, and game numbers — never
   * the ids of their chat accounts.
   * @param {number} [limit=50]
   * @returns {Array<Object>}
   */
  leaderboard (limit = 50) {
    const rows = this._ranked().map((entry) => entry.row);
    const max = Number(limit) > 0 ? Math.floor(Number(limit)) : rows.length;
    return rows.slice(0, max);
  }

  /**
   * Public profile of one player, found by their player id — one id however
   * many chat accounts they link, and unchanged by renames: display name,
   * standing, gear, and game numbers — never the ids of their chat accounts.
   * @param {string} id Player id, as the leaderboard lists it.
   * @returns {Object|null}
   */
  profile (id) {
    const wanted = String(id || '').toLowerCase();
    if (!wanted) return null;
    const ranked = this._ranked();
    const entry = ranked.find((candidate) => candidate.row.id === wanted);
    if (!entry) return null;
    const player = entry.player;
    const level = player.level;
    const gear = (stack) => {
      const stats = items.gearStats(stack);
      return { name: items.displayName(stack), rarity: items.rarity(stack), damage: stats.damage, armor: stats.armor };
    };
    const slain = Object.entries(player.slain)
      .map(([id, count]) => {
        const creature = creatures.get(id);
        return { id, name: creature ? creature.name : id, count };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, TOP_CREATURES);
    return Object.assign({}, entry.row, {
      players: ranked.length,
      levelExperience: Player.experienceForLevel(level),
      nextLevelExperience: Player.experienceForLevel(level + 1),
      battles: { won: player.battles.won, lost: player.battles.lost, total: player.battles.won + player.battles.lost },
      attributes: player.attributes,
      armor: items.equipmentArmor(player.equipment),
      equipment: bodies.slots(Player.BODY)
        .filter((slot) => player.equipment[slot])
        .map((slot) => Object.assign({ slot }, gear(player.equipment[slot]))),
      inventory: player.inventory.map((stack) => ({ name: items.displayName(stack), rarity: items.rarity(stack) })),
      slain
    });
  }

  /**
   * Every player but the bot, best first, as `{ id, player, row }` where
   * `row` is the public leaderboard entry. Ids stay internal.
   * @returns {Array<Object>}
   */
  _ranked () {
    const users = this.content.users;
    return Object.values(this.content.players)
      .filter((record) => !this._isBot(record))
      .map((record) => {
        const player = new Player(record);
        const online = player.accounts.some((account) => this._isPresent(users[accountKey(account)]));
        return {
          id: record.id,
          player,
          row: {
            id: record.id,
            name: this._publicName(player),
            level: player.level,
            experience: player.experience,
            wealth: player.wealth,
            kills: player.kills,
            weapon: player.weapon,
            hours: round1(player.presenceMs / HOUR_MS),
            ticks: player.ticks,
            firstSeen: player.firstSeen ? player.firstSeen.slice(0, 10) : null,
            lastSeen: player.lastSeen ? player.lastSeen.slice(0, 10) : null,
            online
          }
        };
      })
      .sort((a, b) => b.row.experience - a.row.experience || b.row.hours - a.row.hours || a.row.name.localeCompare(b.row.name))
      .map((entry, index) => Object.assign(entry, { row: Object.assign({ rank: index + 1 }, entry.row) }));
  }

  // ### Commands

  _profileFor (actor) {
    const record = this._playerOf(actor);
    return record ? new Player(record) : null;
  }

  async _handleOnlineRequest () {
    const online = this._presentUsers().map((user) => user.name);
    return `Currently present (${online.length}):\n\n\`\`\`\n${JSON.stringify(online, null, '  ')}\n\`\`\``;
  }

  async _handleMemberlistRequest () {
    const members = Object.values(this.content.players).filter((player) => !this._isBot(player)).map((player) => this._publicName(player));
    return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(members, null, '  ')}\n\`\`\``;
  }

  async _handleProfileRequest (message) {
    const player = this._profileFor(message && message.actor);
    if (!player) return `You have not played yet.  Stay present in a game channel to begin.`;
    const a = player.attributes;
    const weapon = player.weapon ? `wielding ${article(player.weapon)}` : 'bare-handed';
    return `You are level **${player.level}** (having earned **${player.experience}** experience) with **${player.wealth}** <small>IDLE</small> in wealth, after **${round1(player.presenceMs / HOUR_MS)}** hours present.  STR ${a.strength} · DEX ${a.dexterity} · CON ${a.constitution}, ${weapon}, **${player.kills}** kills (${player.battles.won}–${player.battles.lost} in battle).`;
  }

  async _handleBalanceRequest (message) {
    const player = this._profileFor(message && message.actor);
    if (!player) return `You have no balance yet.`;
    return `Your current balance is **${player.wealth}** <small>IDLE</small>.  Use \`!transfer <amount> <user>\` to send some to another player.`;
  }

  async _handleLeaderboardRequest () {
    const list = Object.values(this.content.players)
      .sort((a, b) => b.experience - a.experience)
      .slice(0, 10)
      .map((player, n) => `${n + 1}. ${this._publicName(player)}, with **${player.experience}** experience`);
    return `Leaderboard:\n${list.join('\n')}`;
  }

  async _handleTransferRequest (message) {
    if (!message || typeof message.object !== 'string' || typeof message.actor !== 'string') return `Command format: \`!transfer <amount> <user>\``;
    const parts = message.object.trim().split(/\s+/);
    const index = parts.findIndex((part) => part.toLowerCase() === '!transfer');
    const amount = parseInt(parts[index + 1], 10);
    const targetName = parts[index + 2];
    if (!Number.isFinite(amount) || amount <= 0 || !targetName) return `Command format: \`!transfer <amount> <user>\``;

    const actor = this._playerOf(message.actor);
    if (!actor) return `You have no wealth to transfer.`;

    const service = accountOf(message.actor).service;
    const target = this._playerOf(targetName) ||
      (service ? this._playerOf(accountKey({ service, id: targetName })) : null) ||
      Object.values(this.content.players).find((player) => player.name === targetName);
    if (!target) return `Couldn't find ${targetName}.`;
    if (target.id === actor.id) return `You cannot transfer money to yourself.`;
    if (actor.wealth - amount < 0) return `You do not have that amount.  You'll need **${amount - actor.wealth}** more <small>IDLE</small>.`;

    actor.wealth -= amount;
    target.wealth += amount;
    this._dirty = true;
    await this._persist();

    // Whisper on the network the transfer came from when the target is there.
    const account = target.accounts.find((entry) => entry.service === service) || target.accounts[0];
    if (account) this.emit('whisper', {
      target: accountKey(account),
      object: `${this._publicName(actor)} has transferred **${amount}** <small>IDLE</small> to your account!  Check your balance with \`!balance\`.`
    });

    return `Balance transferred successfully!`;
  }
}

module.exports = IdleRPG;
module.exports.Player = Player;
module.exports.WorldClock = WorldClock;
module.exports.STORE_KEY = STORE_KEY;
module.exports.accountOf = accountOf;
module.exports.accountKey = accountKey;
