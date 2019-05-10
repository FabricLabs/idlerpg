'use strict';

// ## IdleRPG Core
// A walkthrough of the Fabric API paired with a working example.

// ### Configuration
const config = require('../config');

// CONSTANTS
// We use the following pattern for storing information that DOES NOT CHANGE.
const {
  PER_TICK_CAPITAL,
  PER_TICK_EXPERIENCE,
  TICK_INTERVAL,
  ENCOUNTER_CHANCE
} = require('../constants');

// ### Dependencies
// Fabric is designed to reduce dependency on external libraries.  At the top of
// every file is the dependency list, specifying outstanding requirements.
const article = require('indefinite-article');
const manager = require('fast-json-patch');
const pointer = require('json-pointer');
const schedule = require('node-schedule');

// ### Fabric Core
// IdleRPG is a demonstration of [Fabric](https://fabric.pub), a peer-to-peer
// protocol for running decentralized applications.  Read the docs!
//
// After including `@fabric/core`, we import RPG, a template class for designing
// & building role-playing games (RPGs).
const Fabric = require('@fabric/core');
const RPG = require('@fabric/rpg');

/**
 * Generic IdleRPG definition.
 */
class IdleRPG extends RPG {
  /**
   * Implements a Game Engine which runs an instance of IdleRPG.
   * @param {Object} config Settings for IdleRPG to use.
   * @param {Number} config.interval Tick interval (in milliseconds).
   * @param {Number} config.luck How likely is an encounter? % chance, 0-1
   * @return {IdleRPG} Instance of IdleRPG.
   */
  constructor (settings = {}) {
    super(settings);

    this.config = Object.assign({
      name: 'idlerpg',
      path: 'stores/idlerpg',
      alias: '@idlerpg:roleplaygateway.com',
      channels: ['idlerpg'],
      services: ['local'],
      interval: TICK_INTERVAL,
      luck: ENCOUNTER_CHANCE,
      PER_TICK_CAPITAL: PER_TICK_CAPITAL,
      PER_TICK_EXPERIENCE: PER_TICK_EXPERIENCE,
      debug: config.debug
    }, settings);

    this.channels = [];
    this.stack = [];

    // ### Our Game State
    // The Game State holds all information necessary to reconstruct your game.
    // We use human-friendly names and keep things as small as possible, so do
    // your part in keeping this well-maintained!
    this.state = {
      channels: {}, // stores a list of channels.
      players: {}, // players are users... !
      services: {}, // services are networks
      users: {} // users are network clients
    };

    // pre-loading Fabric
    this.fabric = new Fabric({
      services: this.config.services
    });

    // configure our own observer
    this.observer = manager.observe(this.state);

    // these are the configurable commands.
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

    this['@entity'] = this.state;

    return this;
  }

  replay (path) {
    let events = null;

    try {
      events = require(`../data/${path}`);
    } catch (E) {
      console.error('Could not load replay:', path, E);
    }

    if (events) {
      console.log('replaying log:', events);
      for (let i = 0; i < events.length; i++) {
        this.fabric.emit(events[i].type, events[i]);
      }
    }
  }

  /**
   * Entry point for running IdleRPG.  Creates a datastore, subscribes to events,
   * initializes the clock, and emits a "ready" event when complete.
   * @return {IdleRPG} Chainable method.
   */
  async start () {
    await super.start();

    console.log('IdleRPG starting...');
    this.log('Start state:', this.state);

    let rpg = this;

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
        console.log('[IDLERPG]', 'service ready:', name);
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
    await super.tick();

    console.debug('[IDLERPG]', `Beginning tick: ${new Date()}`);

    let rpg = this;
    let active = await rpg._getActivePlayers().catch(function errorHandler (E) {
      console.error('[IDLERPG]', 'Could not get active players:', E);
    });

    console.log('active players:', active);

    // TODO: determine validity from signatures
    // sum all transaction signatures to achieve single-signature per block
    for (let i in active) {
      await rpg._computeRound(active[i]);
    }

    let id = await this.save();

    console.debug('[IDLERPG]', `tick ${id} complete: ${new Date()}`);
    // console.debug('[IDLERPG]', `tick state:`, this.state);

    this.emit('tick', id);

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
    console.log('computing round for player:', player);
    let profile = await rpg._getProfile(player.sharing[0]).catch(function (E) {
      console.error('Could not get profile:', E);
    });

    console.log('profile:', profile);
    if (!profile) return false;

    // relax the cooldown...
    if (profile.cooldown) {
      profile.cooldown = profile.cooldown - rpg.config.PER_TICK_CAPITAL;
    }

    let user = rpg.get(`/users/${profile.path}`);
    if (user.presence === 'online') {
      await rpg.reward(profile);
    }

    console.log('round computed:', profile);

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
      let encounter = new RPG.Encounter(player);

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
            claim += `.  They now have **${player.data.inventory.length}** items in their inventory.`;
          }
          rpg.announce(claim);
          break;
      }
    }

    return result;
  }

  async reward (player) {
    let rpg = this;

    console.log('rewarding:', player);
    let instance = await rpg._rollForEncounter(player);

    console.log('instance:', instance);

    if (instance) {
      Object.assign(player, instance);
    }

    // snapshot initial state
    let prior = new RPG.Entity(player);

    // primary updates
    player.data.wealth = (player.data.wealth || 0) + PER_TICK_CAPITAL;
    player.data.experience = (player.data.experience || 0) + PER_TICK_EXPERIENCE;

    // sample the contents
    let sample = new RPG.Entity(player);
    let state = new Fabric.State({ name: player.name });

    if (sample.level && sample.level > prior.level) {
      rpg.announce(`${player.name} has reached level ${sample.level}!`);
    }

    this.set(`/players/${state.id}`, player);

    return this.get(`/players/${state.id}`);
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
    let player = rpg.get(`/players/${id}`);
    let user = rpg.get(`/users/${player.path}`);
    let data = user;

    console.log('get profile got player by name:', player.name);

    let state = new Fabric.State({ name: player.name });
    let profile = Object.assign({
      id: state.id,
      name: data.name,
      path: data.path,
      presence: user.presence || 'offline',
      data: {}
    }, player);

    // #### GAME STATS
    profile.data.health = player.data.health || 100;
    profile.data.stamina = player.data.stamina || 100;
    profile.data.experience = player.data.experience || 0;
    profile.data.inventory = player.data.inventory || [];
    profile.data.effects = player.data.effects || {};
    profile.data.wealth = player.data.wealth || 0;

    // #### CHARACTER EQUIPMENT
    profile.data.equipment = Object.assign({}, player.data.equipment, {
      weapon: player.data.weapon || null
    });

    return profile;
  }

  async _handlePlayRequest (message) {
    return `Join #idlerpg:roleplaygateway.com to play.  Permalink: https://to.fabric.pub/#idlerpg:roleplaygateway.com`;
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

    console.log('handling transfer request:', message);
    let from = `${message.origin.name.toLowerCase()}/users/${message.actor}`;

    console.log('inferred from:', from);

    let actorState = new Fabric.State({ name: message.actor });
    let actorParts = [actorState.id, actorState.render()];

    let targetState = new Fabric.State({ name: parts[2] });
    let targetParts = [targetState.id, targetState.render()];

    let actor = rpg.get(`/players/${actorParts[0]}`);
    let target = rpg.get(`/players/${targetParts[0]}`);
    let amount = parseInt(parts[1]);
    // TODO: handle memo

    let actorID = pointer.escape(actor.id);
    let targetID = pointer.escape(target.id);

    if (!target) return `Couldn't find ${message.target}`;
    if (!actor.data.wealth) return `You have no wealth to transfer.`;
    if (parseInt(actor.data.wealth - amount) < 0) return `You do not have that amount.  You'll need **${parseInt(actor.data.wealth - amount)}** more <small>IDLE</small> to proceed with this transfer.`;

    await rpg._registerPlayer(actor);
    await rpg._registerPlayer(target);

    try {
      // TODO: FUSE filesystem
      let ops = [
        {
          op: 'replace',
          path: `/players/${actorID}/wealth`,
          value: parseInt(actor.data.wealth) - parseInt(amount)
        },
        {
          op: 'replace',
          path: `/players/${targetID}/wealth`,
          value: parseInt(targe.datat.wealth) + parseInt(amount)
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
      return b.data.experience - a.data.experience;
    });

    let members = list.map((x, n) => {
      return `${n}. ${x.name}, with **${x.data.experience}** experience`;
    }).slice(0, 10);

    try {
      rpg._PUT('/leaderboard', members);
    } catch (E) {
      rpg.error('Could not save leaderboard:', E);
    }

    return `Leaderboard:\n${members.join('\n')}`;
  }

  async _getPresence (id) {
    let path = pointer.escape(id);
    return pointer.get(this.state, `/users/${path}/presence`);
  }

  /**
   * Gets an up-to-date list of all IdleRPG players.
   * @return {Array} List of players.
   */
  async _getPlayers () {
    let rpg = this;
    let players = rpg.get(`/players`);
    let users = rpg.get(`/users`);
    return Object.values(players);
  }

  async _getUsers () {
    let rpg = this;
    let users = rpg.get(`/users`);
    return Object.values(users);
  }

  /**
   * Gets a list of all "currently active" IdleRPG players.
   * @return {Array} List of players.
   */
  async _getActivePlayers () {
    let rpg = this;
    let players = await rpg._getPlayers();
    let online = players.filter(player => {
      let user = rpg.get(`/users/${player.path}`);
      return user.presence === 'online';
    });

    return online.filter(function (x) {
      // TODO: configurable exclude of self
      return x.alias !== rpg.config.alias;
    });
  }

  async _handleJoin (join) {
    if (this.config.debug) console.log('[IDLERPG]', 'handling join:', join);

    let channel = await this._registerChannel({
      id: join.channel.toLowerCase(),
      name: join.channel
    });

    let parts = join.channel.split('/');
    if (parts.length === 1) parts = ['local', 'channels', channel.id];
    let state = new Fabric.State(channel);

    let id = state.id;
    let room = `${id}`;
    let path = `/channels/${room}/members`;

    if (
      (this.config.channels.includes(join.channel)) ||
      (this.config.channels.includes(join.channel.toLowerCase()))
    ) {
      let chunks = join.user.split('/');
      if (chunks.length === 1) chunks = ['local', 'users', join.user];
      let player = await this._registerPlayer({ name: join.user });
      let list = this.get(path);
      let set = new Set(list);

      set.add(join.user);

      manager.applyPatch(this.state, [{
        op: 'replace',
        path: path,
        value: Array.from(set)
      }]);

      if (player) {
        await this._welcomePlayer(player);
      }
    }
  }

  async _welcomePlayer (user) {
    this.announce(`Welcome to [IdleRPG](https://github.com/FabricLabs/idlerpg-bot), ${user.name}.  The one rule — _no talking in this channel_ — is now in effect.  **Violators will be slashed.**   Message [@idlerpg](https://matrix.to/#/@idlerpg:verse.im) _directly_ for [\`!help\`](https://github.com/FabricLabs/idlerpg-bot#triggers) or just enjoy the ride.  Best of luck!`);
  }

  async _registerPlayer (player) {
    await super._registerPlayer(player);

    console.log('player to register:', player);

    let result = null;

    // ID is a global identifier, choose it wisely
    let path = pointer.escape(`local/users/${player.name}`);
    let state = new Fabric.State(player);
    let vector = [state.id, state.render()];
    let profile = Object.assign({
      type: 'Player',
      sharing: vector
    }, player, {
      id: state.id,
      path: path,
      name: player.name,
      data: {}
    });

    console.log('player id:', vector[0]);

    try {
      await this.set(`/players/${vector[0]}`, profile);
      await this.set(`/users/${player.path}/players`, [vector[0]]);

      result = this.get(`/players/${vector[0]}`);
    } catch (E) {
      return console.error('Cannot register player:', E);
    }

    return result;
  }

  async _registerUser (user) {
    let path = pointer.escape(`local/users/${user.id}`);
    let result = null;
    let state = new Fabric.State(user);
    let transform = [state.id, state.render()];

    let profile = Object.assign({
      type: 'User',
      sharing: transform,
      presence: 'registering',
      characters: []
    }, user, {
      id: path
    });

    try {
      await this.set(`/users/${path}`, profile);
      result = this.get(`/users/${path}`);
    } catch (E) {
      return console.error('Cannot register user:', E);
    }

    return result;
  }

  async _registerChannel (channel) {
    if (this.config.debug) console.log('[IDLERPG]', 'registering channel:', channel);
    if (!channel.id) return console.error('Channel must have an "id" property.');

    let rpg = this;
    let parts = channel.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'channels', channel.id];
    }

    let id = parts.join('/');
    let data = { name: channel.name, service: 'idlerpg' };
    let state = new Fabric.State(data);
    let hash = state.id;

    data.members = [];

    let target = pointer.escape(id);
    let path = `/channels/${hash}`;
    let obj = Object.assign({
      id: hash,
      members: []
    }, data);

    rpg.set(path, obj);

    return rpg.get(path);
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
    manager.applyPatch(this.state, patches);
    await this.commit();
  }

  async stop () {
    clearInterval(this.clock);
    await this.store.close();
    await super.stop();
    return this;
  }
}

module.exports = IdleRPG;
