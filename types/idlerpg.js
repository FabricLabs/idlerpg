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
const Service = require('@fabric/core/types/service');
const WorldClock = require('@fabric/rpg/types/clock');
const Encounter = require('@fabric/rpg/types/encounter');
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
  RETENTION_DAYS
} = require('../constants');

const STORE_KEY = '/idlerpg';
const UNKNOWN_NAME = 'Unknown pilot';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOP_CREATURES = 5;

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
   * @param {Array<string>} [settings.channels=[]] Channel allowlist (empty = every channel counts).
   * @param {Array<string>} [settings.announcements=[]] Fully qualified targets
   *   (`<service>/channels/<id>`) that receive every announcement instead of the
   *   presence channels. Chatting there is also penalized.
   * @param {boolean} [settings.penalties=true] Slash wealth for chatting in a game channel.
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
      stats: { totalPresentMs: 0, totalTicks: 0, days: {}, lastTick: null, startedAt: null, seed: null, battles: { won: 0, lost: 0 }, slain: {} }
    };

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
    // Older saves predate attributes and gear; Player fills them in.
    for (const [id, record] of Object.entries(content.players)) {
      content.players[id] = new Player(record).toObject();
    }
    // Nobody is known to be present after a restart until the host says so.
    for (const user of Object.values(content.users)) {
      user.presence = 'offline';
      user.channels = {};
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

  // ### Clock

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
    const present = this._presentUsers();

    for (const user of present) {
      const player = this._player(user.id, user.name);
      const record = new Player(player);
      const outcome = record.reward(this.settings.tickMs, this.settings);
      record.lastSeen = new Date(now).toISOString();
      bucket.presentMs += this.settings.tickMs;
      bucket.players[user.id] = 1;
      stats.totalPresentMs += this.settings.tickMs;
      if (outcome.leveled) this.announce(`${this._publicName(record)} has reached level ${outcome.level}!`);
      this._rollForEncounter(record, user);
      Object.assign(player, record.toObject());
    }

    bucket.ticks += 1;
    bucket.peak = Math.max(bucket.peak, present.length);
    stats.totalTicks += 1;
    this.worldClock.clock = stats.totalTicks;
    stats.lastTick = new Date(now).toISOString();
    this._pruneDays(now);

    await this._persist();
    this.emit('tick', { clock: stats.totalTicks, presentNow: present.length, now });
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
   * they are in (or the game itself for channel-less adapters).
   * @param {Object} [user]
   * @returns {Object} `@fabric/rpg` place `{ key, name, kind, biome }`.
   */
  _placeFor (user) {
    const channels = user && user.channels ? Object.keys(user.channels).sort() : [];
    return placeFor(channels[0] || this.settings.alias);
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
    if (name && name !== id && this.content.players[id] && this.content.players[id].name !== name) {
      this.content.players[id].name = name;
      this._dirty = true;
    }
    return users[id];
  }

  _player (id, name) {
    const players = this.content.players;
    if (!players[id]) {
      players[id] = new Player({ id, name, firstSeen: new Date(this.now).toISOString() }).toObject();
      this._dirty = true;
    } else if (name && name !== id && players[id].name !== name) {
      players[id].name = name;
      this._dirty = true;
    }
    return players[id];
  }

  _presentUsers () {
    return Object.values(this.content.users).filter((user) => user.presence === 'online' && user.id !== this.settings.alias);
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
    return player.name && player.name !== player.id ? player.name : UNKNOWN_NAME;
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
   * Presence change. A user is present while they are online in at least one
   * allowed channel (or, for channel-less adapters, while simply online).
   * @param {Object} presence `{ user, status: 'online'|'offline', channel? }`
   */
  async _handlePresence (presence) {
    if (!presence || !presence.user) return null;
    const user = this._user(presence.user);
    const channel = presence.channel || null;
    const wasOnline = user.presence === 'online';

    if (presence.status === 'online') {
      if (channel) {
        if (!this._channelAllowed(channel)) return user;
        // Synchronous: a concurrent join + presence for the same user must not
        // both see `wasOnline === false` (double welcome).
        this._channel({ id: channel });
        this.content.channels[channel].members[user.id] = 1;
        user.channels[channel] = 1;
      } else if (!this._channelAllowed(null)) {
        return user;
      }
      user.presence = 'online';
      if (!wasOnline) {
        user.since = this.now;
        const player = this._player(user.id, user.name);
        if (!player.ticks) await this._welcomePlayer(player);
      }
    } else {
      if (channel) {
        delete user.channels[channel];
        if (this.content.channels[channel]) delete this.content.channels[channel].members[user.id];
      } else {
        for (const id of Object.keys(user.channels)) {
          if (this.content.channels[id]) delete this.content.channels[id].members[user.id];
        }
        user.channels = {};
      }
      if (!Object.keys(user.channels).length) {
        user.presence = 'offline';
        user.since = null;
      }
    }

    this._dirty = true;
    return user;
  }

  /**
   * Chat inside a game channel breaks the silence rule.
   * @param {Object} message `{ actor, target, object }`
   */
  async _handleMessage (message) {
    if (!this.settings.penalties || !message || !message.actor || !message.target) return null;
    if (!this._announcementTargets().includes(message.target)) {
      if (!this.content.channels[message.target]) return null;
      if (!this._channelAllowed(message.target)) return null;
    }
    if (typeof message.object === 'string' && message.object.trim().startsWith('!')) return null;
    const player = this.content.players[message.actor];
    if (!player) return null;
    const record = new Player(player);
    const { notify } = record.penalize();
    Object.assign(player, record.toObject());
    this._dirty = true;
    if (notify) this.announce(`${this._publicName(player)} has disrupted the peace!  Penalties have been applied, but life goes on.`);
    return player;
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
      presentNow: this._presentUsers().length,
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
   * Public leaderboard: display names and game numbers only — no service ids.
   * @param {number} [limit=50]
   * @returns {Array<Object>}
   */
  leaderboard (limit = 50) {
    const users = this.content.users;
    const rows = Object.values(this.content.players)
      .filter((record) => record.id !== this.settings.alias)
      .map((record) => {
        const player = new Player(record);
        const user = users[record.id];
        return {
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
          online: !!(user && user.presence === 'online')
        };
      })
      .sort((a, b) => b.experience - a.experience || b.hours - a.hours || a.name.localeCompare(b.name));
    const max = Number(limit) > 0 ? Math.floor(Number(limit)) : rows.length;
    return rows.slice(0, max).map((row, index) => Object.assign({ rank: index + 1 }, row));
  }

  // ### Commands

  _profileFor (actor) {
    const record = this.content.players[actor];
    return record ? new Player(record) : null;
  }

  async _handleOnlineRequest () {
    const online = this._presentUsers().map((user) => user.name);
    return `Currently present (${online.length}):\n\n\`\`\`\n${JSON.stringify(online, null, '  ')}\n\`\`\``;
  }

  async _handleMemberlistRequest () {
    const members = Object.values(this.content.players).map((player) => player.name);
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
      .map((player, n) => `${n + 1}. ${player.name}, with **${player.experience}** experience`);
    return `Leaderboard:\n${list.join('\n')}`;
  }

  async _handleTransferRequest (message) {
    if (!message || typeof message.object !== 'string' || typeof message.actor !== 'string') return `Command format: \`!transfer <amount> <user>\``;
    const parts = message.object.trim().split(/\s+/);
    const index = parts.findIndex((part) => part.toLowerCase() === '!transfer');
    const amount = parseInt(parts[index + 1], 10);
    const targetName = parts[index + 2];
    if (!Number.isFinite(amount) || amount <= 0 || !targetName) return `Command format: \`!transfer <amount> <user>\``;

    const actor = this.content.players[message.actor];
    if (!actor) return `You have no wealth to transfer.`;

    const prefix = message.actor.split('/').slice(0, 2).join('/');
    const target = this.content.players[targetName] ||
      this.content.players[`${prefix}/${targetName}`] ||
      Object.values(this.content.players).find((player) => player.name === targetName);
    if (!target) return `Couldn't find ${targetName}.`;
    if (target.id === actor.id) return `You cannot transfer money to yourself.`;
    if (actor.wealth - amount < 0) return `You do not have that amount.  You'll need **${amount - actor.wealth}** more <small>IDLE</small>.`;

    actor.wealth -= amount;
    target.wealth += amount;
    this._dirty = true;
    await this._persist();

    this.emit('whisper', {
      target: target.id,
      object: `${actor.name} has transferred **${amount}** <small>IDLE</small> to your account!  Check your balance with \`!balance\`.`
    });

    return `Balance transferred successfully!`;
  }
}

module.exports = IdleRPG;
module.exports.Player = Player;
module.exports.WorldClock = WorldClock;
module.exports.STORE_KEY = STORE_KEY;
