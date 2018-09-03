'use strict';

const util = require('util');
const manager = require('fast-json-patch');
const article = require('indefinite-article');
const schedule = require('node-schedule');

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
    name: 'idlerpg',
    alias: '@idlerpg:verse.im',
    channel: 'idlerpg',
    interval: TICK_INTERVAL,
    luck: ENCOUNTER_CHANCE,
    PER_TICK_CAPITAL: PER_TICK_CAPITAL,
    PER_TICK_EXPERIENCE: PER_TICK_EXPERIENCE
  }, config);

  this.channel = {};
  this.state = {};

  this.fabric = new Fabric();
  this.observer = manager.observe(this.state);
  this.triggers = [
    { name: 'online', value: this._handleOnlineRequest },
    { name: 'memberlist', value: this._handleMemberlistRequest },
    { name: 'play', value: this._handlePlayRequest },
    { name: 'profile', value: this._handleProfileRequest },
    { name: 'inventory', value: this._handleInventoryRequest },
    { name: 'leaderboard', value: this._handleLeaderboardRequest },
    { name: 'transfer', value: this._handleTransferRequest },
    { name: 'balance', value: this._handleBalanceRequest }
  ];

  return this;
}

util.inherits(IdleRPG, require('events').EventEmitter);

/**
 * Entry point for running IdleRPG.  Creates a datastore, subscribes to events,
 * initializes the clock, and emits a "ready" event when complete.
 * @return {IdleRPG} Chainable method.
 */
IdleRPG.prototype.start = async function () {
  let rpg = this;

  rpg.store = new Fabric.Store({ path: './data/idlerpg' });
  rpg.channel = { id: this.config.channel };

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
      console.error('error ticking:', E);
    }
  }, this.config.interval);

  // TODO: document & test
  rpg.newsletter = schedule.scheduleJob('0 0 9 * * *', async function () {
    let leaderboard = await rpg._handleLeaderboardRequest();
    rpg.announce(`A rooster crows in the distance, signalling the break of dawn.  ${leaderboard}`);
  });

  rpg.emit('ready');

  return rpg;
};

/**
 * Clock frame.  Called once per cycle (tick).
 * @fires {IdleRPG#tick} Emitted once the clock cycle is complete.
 * @return {IdleRPG} Chainable method.
 */
IdleRPG.prototype.tick = async function () {
  console.debug('[IDLERPG]', `Beginning tick: ${new Date()}`);

  let rpg = this;
  let players = await rpg._getActivePlayers();

  // TODO: determine validity from signatures
  // sum all transaction signatures to achieve single-signature per block
  for (let i in players) {
    await rpg._computeRound(players[i]);
  }

  this.emit('tick');

  return rpg;
};

/**
 * Commit to the current game state.  Writes state to disk, then broadcasts any
 * outstanding changes.
 * @fires {IdleRPG#patches} An array of changes since the last commit.
 * @return {Boolean} Indicates successful commit.
 */
IdleRPG.prototype.commit = async function sign () {
  let rpg = this;
  let ops = [
    { type: 'put', key: '/', value: JSON.stringify(this.state) }
  ];

  for (let name in this.state) {
    for (let i in this.state[name].users) {
      let user = this.state[name].users[i];
      let op = { type: 'put', key: `/${user.id}`, value: JSON.stringify(user) };
      ops.push(op);
    }
  }

  return this.store.batch(ops, function shareChanges () {
    let patches = manager.generate(rpg.observer);
    if (patches.length) rpg.emit('patches', patches);
  });
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

IdleRPG.prototype._computeRound = async function computeRound (player) {
  let rpg = this;
  let parts = player.id.split('/');
  let profile = await rpg._getProfile(player.id);
  let state = rpg.state[parts[0]][parts[1]][parts[2]];
  let instance = Object.assign({}, profile, state);

  // relax the cooldown...
  if (instance.cooldown) {
    instance.cooldown = instance.cooldown - PER_TICK_CAPITAL;
  }

  if (instance.presence === 'online') {
    await rpg.reward(instance);
  }

  return instance;
};

IdleRPG.prototype._rollForEncounter = async function (instance) {
  let rpg = this;
  let result = null;
  let player = Object.assign({}, instance);

  if (Math.random() < rpg.config.luck) {
    let encounter = new Encounter(player);

    result = Object.assign({}, player, encounter.entity);

    switch (encounter.type) {
      case 'blessing':
        rpg.announce(`${player.name} has been blessed by the Gods!  Good fortune lies ahead.`);
        break;
      case 'monster':
        // TODO: random phrasing
        rpg.announce(`${player.name} came upon a wild ${encounter.state.monster.name} in their adventures!  The fight raged on, but in the end ${player.name} prevailed. **${encounter.state.loot}** gold was looted from the dead corpse.`);
        break;
      case 'item':
        let claim = `${player.name} found a discarded ${encounter.state.item.name}`;
        if (encounter.state.equipped) {
          claim += `, which they have equipped as their main weapon.`;
        } else if (encounter.state.skipped) {
          claim += `, but discarded it as they were carrying too much already.`;
        } else {
          claim += `.  They now have **${player.inventory.length}** items in their inventory.`;
        }
        rpg.announce(claim);
        break;
    }
  }

  return result;
};

IdleRPG.prototype.reward = async function (player) {
  let rpg = this;
  let instance = await rpg._rollForEncounter(player);

  if (instance) {
    Object.assign(player, instance);
  }

  // snapshot initial state
  let prior = new Entity(player);

  // primary updates
  player.wealth = (player.wealth || 0) + PER_TICK_CAPITAL;
  player.experience = (player.experience || 0) + PER_TICK_EXPERIENCE;

  // sample the contents
  let sample = new Entity(player);

  if (sample.level && sample.level > prior.level) {
    rpg.announce(`${player.name} has reached level ${sample.level}!`);
  }

  manager.applyPatch(rpg.state, [
    { op: 'replace', path: `/${player.id}`, value: player }
  ]);

  await rpg.commit();
};

IdleRPG.prototype.penalize = async function (player) {
  let notify = false;

  if (!player.cooldown || player.cooldown < 100) {
    notify = true;
  }

  player.cooldown = 1000;
  player.wealth = player.wealth * 0.5; // slashed!

  manager.applyPatch(this.state, [
    { op: 'replace', path: `/${player.id}/cooldown`, value: player.cooldown },
    { op: 'replace', path: `/${player.id}/wealth`, value: player.wealth }
  ]);

  await this.commit();

  if (notify) {
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
    prior = await rpg.store.get(`/${path}`);
    parsed = JSON.parse(prior);
  } catch (E) {
    console.error('Exception thrown getting profile:', E);
  }

  return Object.assign({}, base, parsed);
};

IdleRPG.prototype._handlePlayRequest = async function (message) {
  return `Join #idlerpg:verse.im to play.  Permalink: https://to.fabric.pub/#/#idlerpg:verse.im`;
};

IdleRPG.prototype._handleProfileRequest = async function (message) {
  let rpg = this;
  let profile = await rpg._getProfile(message.actor);
  let entity = new Entity(profile);
  let effects = Object.keys(entity.effects);
  let response = `You are level **${entity.level}**, with **${profile.stamina}** stamina, **${profile.health}** health, and **${profile.wealth}** wealth.`;

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

IdleRPG.prototype._handleBalanceRequest = async function (message) {
  let rpg = this;
  let profile = await rpg._getProfile(message.actor);
  let response = `Your current balance is **${profile.wealth}** Idlecoin.  You can use \`!transfer <amount> <user>\` to transfer an amount to another user by ID (i.e., \`@eric:ericmartindale.com\`)`;
  return response;
};

IdleRPG.prototype._handleTransferRequest = async function (message) {
  let rpg = this;

  if (!message.object) return `Transfer message must have property "object".`;
  if (!message.actor) return `Transfer message must have property "actor".`;
  if (!(typeof message.object === 'string')) return `Transfer message property "object" must be a string.`;
  if (!(typeof message.actor === 'string')) return `Transfer message property "actor" must be a string.`;

  let parts = (message.object).split(' ');

  if (parts.length < 3) return `Command format: \`!transfer <amount> <user>\``;
  if (message.actor.split('/')[2] === parts[2]) return `You cannot transfer money to yourself.`;

  let actor = await rpg._getProfile(message.actor);
  let amount = parseInt(parts[1]);
  let target = await rpg._getProfile(`${message.origin.name}/users/${parts[2]}`);

  if (!actor.wealth) return `You have no wealth to transfer.`;
  if (parseInt(actor.wealth - amount) < 0) return `You do not have that amount.`;
  if (!target) return `Couldn't find ${message.target}`;

  await rpg._registerPlayer(actor.id);
  await rpg._registerPlayer(target.id);

  try {
    // TODO: FUSE filesystem
    let ops = [
      {
        op: 'replace',
        path: `/${actor.id}/wealth`,
        value: parseInt(actor.wealth) - parseInt(amount)
      },
      {
        op: 'replace',
        path: `/${target.id}/wealth`,
        value: parseInt(target.wealth) + parseInt(amount)
      }
    ];

    manager.applyPatch(rpg.state, ops);
  } catch (E) {
    console.error('[IDLERPG]', 'could not serialize transaction:', E);
    return `Could not complete your transfer request at this time: ${E}`;
  }

  let response = `Balance transferred successfully!`;

  await rpg.commit();

  rpg.emit('whisper', {
    target: target.id,
    message: `${actor.name} (${actor.id}) has transferred **${amount}** Idlecoin to your account!  You can check your balance now with a \`!balance\` inquiry.`
  });

  return response;
};

IdleRPG.prototype._handleOnlineRequest = async function () {
  let rpg = this;
  let list = await rpg._getActivePlayers();
  let online = list.map(x => x.name);
  return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(online, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._handleMemberlistRequest = async function () {
  let rpg = this;
  let list = await rpg._getPlayers();
  let members = list.map(x => x.name);

  return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(members, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._handleLeaderboardRequest = async function () {
  let rpg = this;
  let list = await rpg._getPlayers();

  list.sort(function (a, b) {
    return b.experience - a.experience;
  });

  let members = list.map(x => {
    return `1. ${x.name}, with **${x.experience}** experience`;
  }).slice(0, 10);

  try {
    rpg.fabric._PUT('/leaderboard', members);
  } catch (E) {
    rpg.error('Could not save leaderboard:', E);
  }

  return `Leaderboard:\n${members.join('\n')}`;
};

/**
 * Gets an up-to-date list of all IdleRPG players.
 * @return {Array} List of players.
 */
IdleRPG.prototype._getPlayers = async function () {
  let rpg = this;
  let players = [];

  for (let name in rpg.fabric.services) {
    let service = rpg.fabric.services[name];
    let members = await service._getMembers(rpg.config.channel);

    for (let i in members) {
      let id = [name, 'users', members[i]].join('/');
      let alias = members[i];
      let remote = await service._getUser(members[i]);
      let presence = await service._getPresence(members[i]);
      let profile = Object.assign({}, remote, { id, alias, presence });
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
  let online = players.filter(x => (x.presence === 'online'));

  return online.filter(function (x) {
    // TODO: configurable exclude of self
    return x.alias !== rpg.config.alias;
  });
};

IdleRPG.prototype._handleJoin = async function handleJoin (join) {
  await this._registerChannel({ id: join.channel });
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
 * Takes a {@link User} object and registers it as a player.
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
  let instance = Object.assign({}, prior, user);

  if (!rpg.state[parts[0]]) {
    await rpg._registerService({ name: parts[0] });
  }

  try {
    let raw = JSON.parse(JSON.stringify(instance));
    manager.applyPatch(rpg.state, [{ op: 'replace', path: `/${id}`, value: raw }]);
  } catch (E) {
    console.error('cannot apply patch:', E);
  }

  // save to disk
  await this.commit();

  return rpg.state[parts[0]][parts[1]][parts[2]];
};

// TODO: consider implementing cross-service IdleRPG
IdleRPG.prototype._registerChannel = async function registerChannel (channel) {
  let parts = channel.id.split('/');
  if (parts.length === 1) parts = ['local', 'channels', channel];
  if (parts[2] === this.config.channel) {
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
  let profile = await this._getProfile(message.actor);
  await this.penalize(profile);
};

// TODO: use Fabric for patch event handling
IdleRPG.prototype._handlePatch = async function (patch) {
  console.log('[IDLERPG]', 'handling patch:', patch);
  manager.applyOperation(this.state, patch);
  await this.commit();
};

// TODO: use Fabric for patch event handling
IdleRPG.prototype._handlePatches = async function (patches) {
  console.log('[IDLERPG]', 'handling patches:', patches);
  manager.applyPatch(this.state, patches);
  await this.commit();
};

IdleRPG.prototype.stop = async function () {
  clearInterval(this.clock);
  await this.store.close();
  return this;
};

module.exports = IdleRPG;
