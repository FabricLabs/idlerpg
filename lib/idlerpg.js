'use strict';

const util = require('util');
const manager = require('fast-json-patch');
const article = require('indefinite-article');

const Encounter = require('./encounter');
const Entity = require('./entity');
const Fabric = require('./fabric');

const PER_TICK_CAPITAL = 10;
const PER_TICK_EXPERIENCE = 10;
const TICK_INTERVAL = 600000;
const ENCOUNTER_CHANCE = 0.05;

/**
 * The main IdleRPG constructor.
 * @param       {Object} config Configuration object.
 * @param       {Object} config.interval Tick interval (in milliseconds).
 * @constructor
 */
function IdleRPG (config) {
  this.config = Object.assign({
    interval: TICK_INTERVAL,
    PER_TICK_CAPITAL: PER_TICK_CAPITAL,
    PER_TICK_EXPERIENCE: PER_TICK_EXPERIENCE
  }, config || {});

  this.channel = {};
  this.state = {};
  this.map = {};

  this.fabric = new Fabric();
  this.observer = manager.observe(this.state);
  this.triggers = [
    { name: 'online', value: this._listOnline },
    { name: 'memberlist', value: this._listMembers },
    { name: 'profile', value: this._handleProfileRequest },
    { name: 'inventory', value: this._handleInventoryRequest }
  ];

  return this;
}

util.inherits(IdleRPG, require('events').EventEmitter);

/**
 * Entry point for running IdleRPG.  Creates a datastore, subscribes to events,
 * enumerates currently known players, initializes the clock, and emits a
 * "ready" event when complete.
 * @return {IdleRPG} Chainable method.
 */
IdleRPG.prototype.start = async function () {
  let rpg = this;

  rpg.store = new Fabric.Store({ path: './data/idlerpg' });

  rpg.fabric.on('join', rpg._handleJoin.bind(rpg));
  rpg.fabric.on('part', rpg._disjoinPlayer.bind(rpg));
  rpg.fabric.on('user', rpg._registerUser.bind(rpg));
  rpg.fabric.on('channel', rpg._registerChannel.bind(rpg));
  rpg.fabric.on('message', rpg._handleMessage.bind(rpg));
  rpg.fabric.on('service', rpg._registerService.bind(rpg));
  rpg.fabric.on('patch', rpg._handlePatch.bind(rpg));
  rpg.fabric.on('patches', rpg._handlePatches.bind(rpg));

  rpg.clock = setInterval(function () {
    try {
      rpg.tick();
    } catch (E) {
      console.error(E);
    }
  }, this.config.interval);

  rpg.emit('ready');

  return rpg;
};

/**
 * Clock frame.  Called once per cycle (tick).
 * @return {IdleRPG} Chainable method.
 */
IdleRPG.prototype.tick = async function () {
  console.debug('[IDLERPG]', `Beginning tick: ${new Date()}`);

  let rpg = this;
  let players = await rpg._getActivePlayers();

  for (let i in players) {
    let id = players[i].id;
    let parts = id.split('/');
    let profile = await rpg._getProfile(id);
    let player = Object.assign({}, rpg.state[parts[0]][parts[1]][parts[2]], profile);

    if (player.cooldown) {
      player.cooldown = player.cooldown - PER_TICK_CAPITAL;
    }

    console.log('the player:', player);

    if (player.presence === 'online') {
      let turn = rpg.beginTurn(player);

      if (turn.encounter) {
        manager.applyPatch(player, turn.encounter.patches);

        switch (turn.encounter.type) {
          case 'blessing':
            rpg.announce(`${player.name} has been blessed by the Gods!  Good fortune lies ahead.`);
            break;
          case 'monster':
            // TODO: random phrasing
            rpg.announce(`${player.name} came upon a wild ${turn.encounter.state.monster.name} in their adventures!  The fight raged on, but in the end ${player.name} prevailed. **${turn.encounter.state.loot}** gold was looted from the dead corpse.`);
            break;
          case 'item':
            let claim = `${player.name} found a discarded ${turn.encounter.state.item.name}`;
            if (turn.encounter.state.equipped) {
              claim += `, which they have equipped as their main weapon.`;
            } else if (turn.encounter.state.skipped) {
              claim += `, but discarded it as they were carrying too much already.`;
            } else {
              claim += `.  They now have **${player.inventory.length}** items in their inventory.`;
            }
            rpg.announce(claim);
            break;
        }
      }

      player.wealth = (player.wealth || 0) + PER_TICK_CAPITAL;
      player.experience = (player.experience || 0) + PER_TICK_EXPERIENCE;

      manager.applyPatch(rpg.state, [
        { op: 'replace', path: '/' + id, value: player }
      ]);

      try {
        await rpg.store.set(player.id, JSON.stringify(player));
      } catch (E) {
        console.error('Could not save data:', player);
      }

      await rpg.commit();
    }
  }

  this.emit('tick');

  return rpg;
};

IdleRPG.prototype.commit = async function sign () {
  try {
    await this.store.set('/', JSON.stringify(this.state));
    this.emit('patches', manager.generate(this.observer));
  } catch (E) {
    console.error('Could not commit state:', E);
  }
};

IdleRPG.prototype.announce = function (message) {
  let rpg = this;
  for (let name in rpg.fabric.services) {
    this.emit('message', {
      actor: this.actor,
      object: message,
      target: [name, 'channels', rpg.config.channel].join('/')
    });
  }
};

IdleRPG.prototype.beginTurn = function (instance) {
  let result = {};
  let player = Object.assign({}, instance);

  if (Math.random() < ENCOUNTER_CHANCE) {
    result.encounter = new Encounter(player);
  }

  return result;
};

IdleRPG.prototype.penalize = async function (player) {
  player.cooldown = 1000;
  player.wealth = player.wealth * 0.5; // slashed!

  await this.commit();

  if (!player.cooldown || player.cooldown < 100) {
    this.announce(`${player.name} has disrupted the peace!  Penalties have been applied, but life goes on.`);
  }
};

IdleRPG.prototype.flush = function () {
  return this.store.flush();
};

IdleRPG.prototype._getProfile = async function (id) {
  let rpg = this;
  let parts = id.split('/');

  if (parts.length === 1) {
    parts = ['local', 'users', id];
  }

  let path = parts.join('/');
  let base = new Entity({
    id: path,
    type: 'User',
    inventory: [],
    health: 100,
    stamina: 100,
    wealth: 10,
    weapon: null
  });

  let prior = null;
  let parsed = null;

  try {
    prior = await rpg.store.get(path);
    parsed = JSON.parse(prior);
  } catch (E) {
    console.warn('No such profile:', id);
  }

  return Object.assign({}, base, parsed);
};

IdleRPG.prototype._handleProfileRequest = async function (message) {
  let rpg = this;
  let profile = await rpg._getProfile(message.actor);
  let effects = Object.keys(profile.effects);
  let response = `You have **${profile.stamina}** stamina, **${profile.health}** health, and **${profile.wealth}** wealth.`;

  // TODO: switch to something like "gear" or "equipment"
  if (profile.weapon) {
    response += `  Your current weapon is ${article(profile.weapon.name)} **${profile.weapon.name}**, which has **${profile.weapon.attack}** attack and **${profile.weapon.durability}** durability.`;
  }

  if (effects.length) {
    response += `  You are currently ${effects[0]}.`;
  } else {
    response += `  No special statuses are currently applied.`;
  }

  return response;
};

IdleRPG.prototype._handleInventoryRequest = async function (message) {
  let rpg = this;
  let profile = await rpg._getProfile(message.actor);
  if (!profile.inventory.length) return `You have no items in your inventory.`;
  let response = `Your inventory:`;

  for (let i in profile.inventory) {
    let item = profile.inventory[i];
    response += `\n- ${article(item.name)} **${item.name}**, with **${item.attack}** attack and **${item.durability}** durability`;
  }

  return response;
};

IdleRPG.prototype._getOnline = function () {
  let rpg = this;
  let online = [];

  for (let name in rpg.state) {
    for (let id in rpg.state[name].users) {
      let user = rpg.state[name].users[id];
      if (user.online === true) online.push(user);
    }
  }

  return online.map(x => x.id);
};

IdleRPG.prototype._listOnline = function () {
  let rpg = this;
  let list = rpg._getOnline().map(x => rpg._getProfile(x).name);
  return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._listMembers = async function () {
  let rpg = this;
  let list = await rpg._getPlayers();
  let members = list.map(x => x.name);

  return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(members, null, '  ')}\n\`\`\``;
};

/**
 * Gets an up-to-date list of all IdleRPG players.
 * @return {Array} List of players.
 */
IdleRPG.prototype._getPlayers = async function () {
  let rpg = this;
  let players = [];

  // TODO: parallelize
  for (let name in rpg.fabric.services) {
    let service = rpg.fabric.services[name];
    let members = await service._getMembers(rpg.config.channel);

    for (let i in members) {
      let id = [name, 'users', members[i]].join('/');
      let remote = await service._getUser(members[i]);
      let profile = Object.assign(remote, { id });
      let saved = await rpg._registerUser(profile);

      if (saved) {
        players.push(saved);
      }
    }
  }

  return players;
};

/**
 * Gets a list of all "currently active" IdleRPG players.
 * @return {Array} List of players.
 */
IdleRPG.prototype._getActivePlayers = async function () {
  let rpg = this;
  let players = await rpg._getPlayers();
  return players.filter(x => (x.presence === 'online'));
};

IdleRPG.prototype._handleJoin = async function handleJoin (join) {
  let parts = join.channel.split('/');
  if (parts.length === 1) parts = ['local', 'channels', join.channel];
  if (parts[2] === this.config.channel) {
    let chunks = join.user.split('/');
    if (chunks.length === 1) chunks = ['local', 'users', join.user];
    let player = await this._registerPlayer(join.user);
    await this._welcomePlayer(player);
  }
};

IdleRPG.prototype._welcomePlayer = async function welcomePlayer (user) {
  this.announce(`Welcome to [IdleRPG](https://github.com/FabricLabs/idlerpg-bot), ${user.name}.  The one rule — _no talking in this channel_ — is now in effect.  **Violators will be slashed.**   Message [@idlerpg](https://matrix.to/#/@idlerpg:verse.im) _directly_ for [\`!help\`](https://github.com/FabricLabs/idlerpg-bot#triggers) or just enjoy the ride.  Best of luck!`);
};

IdleRPG.prototype._registerPlayer = async function registerPlayer (player) {
  let parts = player.split('/');

  if (parts.length === 1) {
    parts = ['local', 'users', player];
  }

  let result = await this.fabric.services[parts[0]]._getUser(parts[2]);
  let user = Object.assign({}, {
    name: parts[2]
  }, result, {
    id: [parts[0], 'users', parts[2]].join('/')
  });

  return this._registerUser(user);
};

/**
 * Takes a {@Link User} object and registers it as a player.
 * @param  {User} user User to register as a Player.
 * @return {Player}      Instance of the Player object.
 */
IdleRPG.prototype._registerUser = async function registerUser (user) {
  if (!user.id) return console.error('User must have an "id" property.');
  if (!user.name) return console.error('User must have a "name" property.');

  let rpg = this;
  let parts = user.id.split('/');

  if (parts.length === 1) {
    parts = ['local', 'users', user.id];
  }

  let id = parts.join('/');
  let prior = await rpg._getProfile(id);

  if (!rpg.state[parts[0]]) {
    rpg._registerService({ name: parts[0] });
  }

  let instance = Object.assign({}, prior, user);

  try {
    let raw = JSON.parse(JSON.stringify(instance));
    manager.applyPatch(rpg.state, [{ op: 'replace', path: `/${id}`, value: raw }]);
  } catch (E) {
    console.error('cannot apply patch:', E);
  }

  // save to disk
  let saved = await rpg.store.set(id, JSON.stringify(instance));
  if (saved) {
    await this.commit();
  } else {
    console.error('registration failed:', saved);
  }

  return rpg.state[parts[0]][parts[1]][parts[2]];
};

// TODO: consider implementing cross-service IdleRPG
IdleRPG.prototype._registerChannel = async function registerChannel (channel) {
  // console.log('[IDLERPG]', 'registering channel:', channel);
  if (channel['@data'].id === this.config.channel) {
    this.channel = channel;
  }
};

IdleRPG.prototype._registerService = async function registerService (service) {
  manager.applyPatch(this.state, [
    { op: 'add', path: `/${service.name}`, value: { users: {} } }
  ]);
  await this.commit();
};

// TODO: implement
IdleRPG.prototype._disjoinPlayer = async function disjoinPlayer (id) {
  return this;
};

IdleRPG.prototype._handleMessage = async function handleMessage (message) {
  if (message.target !== this.channel.id) return;
  await this.penalize(message.actor);
};

// TODO: use Fabric for patch event handling
IdleRPG.prototype._handlePatch = async function (patch) {
  console.log('[IDLERPG]', 'handling patch:', patch);
  manager.applyOperation(this.state, patch);
  let internal = manager.generate(this.observer);
  this.emit('patches', internal);
};

// TODO: use Fabric for patch event handling
IdleRPG.prototype._handlePatches = async function (patches) {
  console.log('[IDLERPG]', 'handling patches:', patches);
  manager.applyPatch(this.state, patches);
  let internal = manager.generate(this.observer);
  this.emit('patches', internal);
};

IdleRPG.prototype.stop = async function () {
  clearInterval(this.clock);
  return this.store.close();
};

module.exports = IdleRPG;
