'use strict';

const {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  TICK_INTERVAL,
  ENCOUNTER_CHANCE
} = require('../constants');

const article = require('indefinite-article');
const manager = require('fast-json-patch');
const pointer = require('json-pointer');
const schedule = require('node-schedule');

// Fabric Core
const Fabric = require('@fabric/core');

// Internal Types
const Encounter = require('./encounter');
const Entity = require('./entity');

/**
 * Generic IdleRPG definition.
 */
class IdleRPG extends Fabric {
  /**
   * C
   * @param {Object} config Settings for IdleRPG to use.
   * @param {Number} config.interval Tick interval (in milliseconds).
   * @return {IdleRPG} Instance of IdleRPG.
   */
  constructor (config) {
    super(config);
    this.config = Object.assign({
      name: 'idlerpg',
      alias: '@idlerpg:verse.im',
      channels: ['idlerpg'],
      interval: TICK_INTERVAL,
      luck: ENCOUNTER_CHANCE,
      PER_TICK_CAPITAL: PER_TICK_CAPITAL,
      PER_TICK_EXPERIENCE: PER_TICK_EXPERIENCE
    }, config);

    this.channels = [];
    this.stack = [];

    this.state = {
      channels: {},
      players: {},
      services: {},
      users: {}
    };

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

  /**
   * Entry point for running IdleRPG.  Creates a datastore, subscribes to events,
   * initializes the clock, and emits a "ready" event when complete.
   * @return {IdleRPG} Chainable method.
   */
  async start () {
    console.log('IdleRPG starting...');

    let rpg = this;

    rpg.store = new Fabric.Store({ path: './data/idlerpg' });

    try {
      let state = await rpg.store.get('/');
      let parsed = JSON.parse(state);
      let merged = Object.assign({}, rpg.state, parsed);
      rpg.state = merged;
    } catch (E) {
      console.error('Could not restore state:', E);
    }

    rpg.fabric.on('join', rpg._handleJoin.bind(rpg));
    rpg.fabric.on('part', rpg._disjoinPlayer.bind(rpg));
    rpg.fabric.on('user', rpg._registerUser.bind(rpg));
    rpg.fabric.on('channel', rpg._registerChannel.bind(rpg));
    rpg.fabric.on('message', rpg._handleMessage.bind(rpg));
    rpg.fabric.on('service', rpg._registerService.bind(rpg));
    rpg.fabric.on('patch', rpg._handlePatch.bind(rpg));
    rpg.fabric.on('patches', rpg._handlePatches.bind(rpg));

    for (let name in rpg.fabric.services) {
      let service = rpg.fabric.services[name];
      service.once('ready', async function () {
        for (let i in rpg.config.channels) {
          let channel = rpg.config.channels[i];
          let members = [];
          let present = false;

          try {
            members = await service._getMembers(channel);
          } catch (E) {
            rpg.error(`Couldn't get members for "${channel}":`, E);
          }

          if (members) {
            rpg.channels.push(channel);
            present = members.includes(service.self.id);
          }

          if (!present) {
            await service.join(channel);
          }
        }
      });
    }

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
  }

  /**
   * Clock frame.  Called once per cycle (tick).
   * @fires {IdleRPG#tick} Emitted once the clock cycle is complete.
   * @return {IdleRPG} Chainable method.
   */
  async tick () {
    console.debug('[IDLERPG]', `Beginning tick: ${new Date()}`);

    let rpg = this;
    let players = await rpg._getActivePlayers().catch(function errorHandler (E) {
      console.error('[IDLERPG]', 'Could not get active players:', E);
    });

    // TODO: determine validity from signatures
    // sum all transaction signatures to achieve single-signature per block
    for (let i in players) {
      await rpg._computeRound(players[i]);
    }

    this.emit('tick');

    return rpg;
  }

  /**
   * Commit to the current game state.  Writes state to disk, then broadcasts any
   * outstanding changes.
   * @fires {IdleRPG#patches} An array of changes since the last commit.
   * @return {Boolean} Indicates successful commit.
   */
  async commit () {
    let rpg = this;
    let ops = [
      { type: 'put', key: '/', value: JSON.stringify(this.state) }
    ];

    for (let name in rpg.state) {
      let op = { type: 'put', key: `/${name}`, value: JSON.stringify(rpg.state[name]) };
      ops.push(op);
    }

    return this.store.batch(ops, function shareChanges () {
      let patches = manager.generate(rpg.observer);
      if (patches.length) rpg.emit('patches', patches);
    });
  }

  async _computeRound (player) {
    let rpg = this;

    let profile = await rpg._getProfile(player.id).catch(function (E) {
      console.error('Could not get profile:', E);
    });

    if (!profile) return false;

    // relax the cooldown...
    if (profile.cooldown) {
      profile.cooldown = profile.cooldown - rpg.config.PER_TICK_CAPITAL;
    }

    if (profile.presence === 'online') {
      await rpg.reward(profile);
    }

    return profile;
  }

  async announce (message) {
    let rpg = this;
    for (let name in rpg.fabric.services) {
      for (let i in rpg.channels) {
        this.emit('message', {
          actor: this.actor,
          object: message,
          target: [name, 'channels', rpg.channels[i]].join('/')
        });
      }
    }
  }

  async _rollForEncounter (instance) {
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
  }

  async reward (player) {
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

    let target = pointer.escape(player.id);

    manager.applyPatch(rpg.state, [
      { op: 'replace', path: `/players/${target}`, value: player }
    ]);

    await rpg.commit();
  }

  async penalize (player) {
    let notify = false;
    let target = pointer.escape(player.id);

    if (!player.cooldown || player.cooldown < 100) {
      notify = true;
    }

    player.cooldown = 1000;
    player.wealth = player.wealth * 0.5; // slashed!

    manager.applyPatch(this.state, [
      { op: 'replace', path: `/players/${target}/cooldown`, value: player.cooldown },
      { op: 'replace', path: `/players/${target}/wealth`, value: player.wealth }
    ]);

    await this.commit();

    if (notify) {
      this.announce(`${player.name} has disrupted the peace!  Penalties have been applied, but life goes on.`);
    }
  }

  /**
   * Get a {@link Player} profile by ID.
   * @param  {String} id Player ID.
   * @return {Player}    Instance of the {@link Player} object.
   */
  async _getProfile (id) {
    let rpg = this;
    let parts = id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', id];
    }

    let path = parts.join('/');
    let target = pointer.escape(path);

    let old = null;
    let prior = null;
    let backup = null;

    try {
      old = await rpg.store.get(`/${path}`);
      backup = JSON.parse(old);
    } catch (E) {
      // console.error('Exception thrown getting (old) profile:', E);
    }

    try {
      // TODO: use Fabric._GET
      // prior = await rpg.fabric._GET(`/players/${target}`);
      prior = await rpg._GET(`/players/${target}`);
    } catch (E) {
      console.error('Exception thrown getting profile:', E);
    }

    let base = new Entity({ id: path });
    let data = Object.assign({}, base, backup, prior);
    let profile = {
      id: data.id,
      name: data.name,
      type: 'Player',
      health: data.health || 100,
      stamina: data.stamina || 100,
      experience: data.experience || 0,
      equipment: Object.assign({}, data.equipment, {
        weapon: data.weapon || null
      }),
      inventory: data.inventory || [],
      presence: data.presence || 'offline',
      effects: data.effects || {},
      wealth: data.wealth || 0
    };

    return profile;
  }

  async _handlePlayRequest (message) {
    return `Join #idlerpg:verse.im to play.  Permalink: https://to.fabric.pub/#idlerpg:verse.im`;
  }

  async _handleProfileRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    let entity = new Entity(profile);
    let effects = Object.keys(entity.effects);
    let equipment = profile.equipment;
    let response = `You are level **${entity.level}** (having earned **${profile.experience}** experience), with **${profile.stamina}** stamina, **${profile.health}** health, and **${profile.wealth}** <small>IDLE</small> in wealth.`;

    if (equipment.weapon) {
      response += `  Your current weapon is ${article(equipment.weapon.name)} **${equipment.weapon.name}**, which has **${equipment.weapon.attack}** attack and **${equipment.weapon.durability}** durability.`;
    }

    if (effects.length) {
      response += `  You are currently ${effects[0]}.`;
    } else {
      response += `  No special statuses are currently applied.`;
    }

    return response;
  }

  async _handleInventoryRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    if (!profile.inventory.length) return `You have no items in your inventory.`;
    let response = `Your inventory:`;

    for (let i in profile.inventory) {
      let item = profile.inventory[i];
      response += `\n- ${article(item.name)} **${item.name}**, with **${item.attack}** attack and **${item.durability}** durability`;
    }

    return response;
  }

  async _handleBalanceRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    let response = `Your current balance is **${profile.wealth}** <small>IDLE</small>.  You can use \`!transfer <amount> <user>\` to transfer an amount to another user by ID (i.e., \`@eric:ericmartindale.com\`)`;
    return response;
  }

  async _handleTransferRequest (message) {
    let rpg = this;

    if (!message.object) return `Transfer message must have property "object".`;
    if (!message.actor) return `Transfer message must have property "actor".`;
    if (!(typeof message.object === 'string')) return `Transfer message property "object" must be a string.`;
    if (!(typeof message.actor === 'string')) return `Transfer message property "actor" must be a string.`;

    let parts = (message.object).split(' ');

    if (parts.length < 3) return `Command format: \`!transfer <amount> <user>\``;
    if (message.actor.split('/')[2] === parts[2]) return `You cannot transfer money to yourself.`;

    let actor = await rpg._getProfile(message.actor);
    let target = await rpg._getProfile(`${message.origin.name}/users/${parts[2]}`);
    let amount = parseInt(parts[1]);
    // TODO: handle memo

    let actorID = pointer.escape(actor.id);
    let targetID = pointer.escape(target.id);

    if (!target) return `Couldn't find ${message.target}`;
    if (!actor.wealth) return `You have no wealth to transfer.`;
    if (parseInt(actor.wealth - amount) < 0) return `You do not have that amount.  You'll need **${parseInt(actor.wealth - amount)}** more <small>IDLE</small> to proceed with this transfer.`;

    await rpg._registerPlayer(actor);
    await rpg._registerPlayer(target);

    try {
      // TODO: FUSE filesystem
      let ops = [
        {
          op: 'replace',
          path: `/players/${actorID}/wealth`,
          value: parseInt(actor.wealth) - parseInt(amount)
        },
        {
          op: 'replace',
          path: `/players/${targetID}/wealth`,
          value: parseInt(target.wealth) + parseInt(amount)
        }
      ];

      manager.applyPatch(rpg.state, ops);
    } catch (E) {
      console.error('[IDLERPG]', 'could not serialize transaction:', E);
      return `Could not complete your transfer request at this time: ${E}`;
    }

    await rpg.commit();

    rpg.emit('whisper', {
      target: target.id,
      message: `${actor.name} (${actor.id}) has transferred **${amount}** <small>IDLE</small> to your account!  You can check your balance now with a \`!balance\` inquiry.`
    });

    return `Balance transferred successfully!`;
  }

  async _handleOnlineRequest () {
    let rpg = this;
    let list = await rpg._getActivePlayers();
    let online = list.map(x => x.name);
    return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(online, null, '  ')}\n\`\`\``;
  }

  async _handleMemberlistRequest () {
    let rpg = this;
    let list = await rpg._getPlayers();
    let members = list.map(x => x.name);

    return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(members, null, '  ')}\n\`\`\``;
  }

  async _handleLeaderboardRequest () {
    let rpg = this;
    let list = await rpg._getPlayers();

    list.sort(function (a, b) {
      return b.experience - a.experience;
    });

    let members = list.map(x => {
      return `1. ${x.name}, with **${x.experience}** experience`;
    }).slice(0, 10);

    try {
      rpg._PUT('/leaderboard', members);
    } catch (E) {
      rpg.error('Could not save leaderboard:', E);
    }

    return `Leaderboard:\n${members.join('\n')}`;
  }

  /**
   * Gets an up-to-date list of all IdleRPG players.
   * @return {Array} List of players.
   */
  async _getPlayers () {
    let rpg = this;
    let players = [];

    for (let name in rpg.fabric.services) {
      let service = rpg.fabric.services[name];
      for (let i in rpg.channels) {
        let members = await service._getMembers(rpg.channels[i]).catch(rpg.error);
        for (let j in members) {
          let path = [name, 'users', members[j]].join('/');
          let profile = await rpg._getProfile(path).catch(rpg.error);
          let player = await rpg._registerPlayer(profile).catch(rpg.error);

          if (player) {
            player.presence = await service._getPresence(members[j]).catch(rpg.error);
            players.push(player);
          }
        }
      }
    }

    return players;
  }

  /**
   * Gets a list of all "currently active" IdleRPG players.
   * @return {Array} List of players.
   */
  async _getActivePlayers () {
    let rpg = this;
    let players = await rpg._getPlayers();
    let online = players.filter(x => (x.presence === 'online'));

    return online.filter(function (x) {
      // TODO: configurable exclude of self
      return x.alias !== rpg.config.alias;
    });
  }

  async _handleJoin (join) {
    if (this.config.debug) console.log('[IDLERPG]', 'handling join:', join);

    await this._registerChannel({
      id: join.channel,
      name: join.channel
    });

    let parts = join.channel.split('/');

    if (parts.length === 1) parts = ['local', 'channels', join.channel];
    if (this.channels.includes(parts[2])) {
      let chunks = join.user.split('/');
      if (chunks.length === 1) chunks = ['local', 'users', join.user];
      let player = await this._registerPlayer({ id: join.user });
      await this._welcomePlayer(player);
    }
  }

  async _welcomePlayer (user) {
    this.announce(`Welcome to [IdleRPG](https://github.com/FabricLabs/idlerpg-bot), ${user.name}.  The one rule — _no talking in this channel_ — is now in effect.  **Violators will be slashed.**   Message [@idlerpg](https://matrix.to/#/@idlerpg:verse.im) _directly_ for [\`!help\`](https://github.com/FabricLabs/idlerpg-bot#triggers) or just enjoy the ride.  Best of luck!`);
  }

  async _registerPlayer (player) {
    if (!player.id) return console.error('Player must have an "id" property.');

    let rpg = this;
    let parts = player.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', player];
    }

    let id = [parts[0], 'users', parts[2]].join('/');
    let target = pointer.escape(id);
    let path = `/players/${target}`;
    let data = Object.assign({}, player);

    try {
      manager.applyPatch(rpg.state, [{
        op: 'replace',
        path: path,
        value: data
      }]);
    } catch (E) {
      console.error('cannot apply patch:', E);
    }

    await rpg.commit();

    let profile = rpg._GET(`/players/${target}`);

    return profile;
  }

  /**
   * Takes a {@link User} object and registers it as a player.
   * @param  {User} user User to register as a Player.
   * @return {Player}      Instance of the Player object.
   */
  async _registerUser (user) {
    if (!user.id) return console.error('User must have an "id" property.');
    if (!user.name) return console.error('User must have a "name" property.');

    let rpg = this;
    let parts = user.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', user.id];
    }

    let id = parts.join('/');
    let target = pointer.escape(id);
    let path = `/users/${target}`;
    let profile = await rpg._getProfile(id);

    try {
      manager.applyPatch(rpg.state, [{
        op: 'replace',
        path: path,
        value: profile
      }]);
    } catch (E) {
      console.error('cannot apply patch:', E);
    }

    // save to disk
    await rpg.commit();

    return rpg._GET(path);
  }

  async _registerChannel (channel) {
    if (!channel.id) return console.error('Channel must have an "id" property.');

    let rpg = this;
    let parts = channel.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'channels', channel.id];
    }

    let id = parts.join('/');
    let target = pointer.escape(id);
    let path = `/channels/${target}`;
    let data = Object.assign({
      id: id,
      name: channel.name || id,
      members: []
    }/*, channel */);

    try {
      manager.applyPatch(rpg.state, [{ op: 'replace', path: path, value: data }]);
    } catch (E) {
      console.error('cannot apply patch:', E);
    }

    await this.commit();

    return rpg._GET(path);
  }

  async _registerService (service) {
    manager.applyPatch(this.state, [{
      op: 'add',
      path: `/services/${service.name}`,
      value: {
        users: {},
        channels: {}
      }
    }]);
    await this.commit();
  }

  // TODO: implement
  async _disjoinPlayer (id) {
    return this;
  }

  async _handleMessage (message) {
    if (!this.channels.includes(message.target)) return;
    let profile = await this._getProfile(message.actor);
    await this.penalize(profile);
  }

  // TODO: use Fabric for patch event handling
  async _handlePatch (patch) {
    console.log('[IDLERPG]', 'handling patch:', patch);
    manager.applyOperation(this.state, patch);
    await this.commit();
  }

  // TODO: use Fabric for patch event handling
  async _handlePatches (patches) {
    console.log('[IDLERPG]', 'handling patches:', patches);
    manager.applyPatch(this.state, patches);
    await this.commit();
  }

  async stop () {
    clearInterval(this.clock);
    await this.store.close();
    return this;
  }
}

module.exports = IdleRPG;
