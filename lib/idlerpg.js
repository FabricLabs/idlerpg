'use strict';

const fs = require('fs');
const util = require('util');
const level = require('level');

const Encounter = require('./encounter');

const PER_TICK_CAPITAL = 10;
const TICK_INTERVAL = 600000;

function IdleRPG (config) {
  let root = config.root || './data';

  // TODO: switch to Fabric's disk implementation
  if (!fs.existsSync(root)) fs.mkdirSync(root);
  this.db = level(root + '/idlerpg');

  this.config = Object.assign({
    interval: TICK_INTERVAL
  }, config || {});
  this.channel = {};
  this.map = {};

  this.triggers = [
    {
      name: 'idlerpg',
      value: this.debug
    },
    {
      name: 'online',
      value: this._listOnline
    },
    {
      name: 'memberlist',
      value: this._listMembers
    }
  ];

  return this;
}

util.inherits(IdleRPG, require('events').EventEmitter);

IdleRPG.prototype.tick = async function () {
  console.log(`${new Date()}: Beginning tick...`);

  let rpg = this;

  for (let name in rpg.fabric.services) {
    let service = rpg.fabric.services[name];
    let members = await service._getMembers(rpg.channel['@data'].id);

    console.log('services:', Object.keys(rpg.fabric.services));
    console.log('service nam:', name);
    console.log('getSubscriptions:', service._getSubscriptions);
    console.log('service subscriptions:', members);

    if (!members) continue;

    for (let i in members) {
      let id = [name, 'users', members[i]].join('/');
      console.log(`checking ${i}...`);
      let presence = await service._getPresence(members[i]);

      console.log(`presence for ${members[i]} (${rpg.map[id].name}) was ${presence}`);

      await this._registerUser({ id });

      // TODO: test last activity time > 10 minutes ago
      if (presence === 'active') {
        let changes = rpg.wanderWith(id);

        console.log('presence was active, changes to user:', changes);

        rpg.map[id].online = true;
        rpg.map[id].wealth = (rpg.map[id].wealth || 0) + PER_TICK_CAPITAL;
      } else {
        rpg.map[id].online = false;
      }

      await rpg.db.put(id, JSON.stringify(rpg.map[id]));
    }

    console.log('loop for service', name, 'complete');
  }

  return rpg;
};

IdleRPG.prototype.start = function () {
  let rpg = this;

  if (rpg.fabric && !rpg.stream) {
    rpg.stream = rpg.subscribe('/'); // subscribe to all Fabric events
  }

  rpg.fabric.on('user', rpg._registerUser.bind(rpg));
  rpg.fabric.on('channel', rpg._registerChannel.bind(rpg));
  rpg.fabric.on('message', rpg._handleMessage.bind(rpg));
  rpg.fabric.on('patch', rpg._handlePatch.bind(rpg));

  rpg.fabric._joinRoom(rpg.config.channel);

  rpg.timer = setInterval(function () {
    try {
      rpg.tick();
    } catch (E) {
      console.error(E);
    }
  }, this.config.interval);

  return rpg;
};

IdleRPG.prototype.wander = function () {
  let result = {};
  let chance = 0.5;

  if (Math.random() > chance) {
    let encounter = new Encounter();
  }

  return result;
};

IdleRPG.prototype.wanderWith = function (user) {
  let result = {};
  let chance = 0.5;

  if (Math.random() > chance) {
    result.encounter = new Encounter();
  }

  return result;
};

IdleRPG.prototype.debug = function () {
  let doorman = this;
  let list = Object.keys(doorman.plugins['idlerpg'].map).filter(x => {
    return doorman.plugins['idlerpg'].map[x].type === 'User';
  }).filter(x => {
    return doorman.plugins['idlerpg'].map[x].online === true;
  }).map(x => {
    return Object.assign({}, doorman.plugins['idlerpg'].map[x], {
      '@data': null
    });
  });

  return `Current debug data for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._getOnline = function () {
  let doorman = this;

  return Object.keys(doorman.plugins['idlerpg'].map).filter(x => {
    return doorman.plugins['idlerpg'].map[x].type === 'User';
  }).filter(x => {
    return doorman.plugins['idlerpg'].map[x].online === true;
  });
};

IdleRPG.prototype._listOnline = function () {
  let doorman = this;
  let list = doorman.plugins['idlerpg']._getOnline.apply(doorman).map(x => doorman.plugins['idlerpg'].map[x].name);

  return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._listMembers = function () {
  let doorman = this;
  let list = Object.keys(doorman.plugins['idlerpg'].map).filter(x => {
    return doorman.plugins['idlerpg'].map[x].type === 'User';
  });

  return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._registerUser = async function registerUser (user) {
  let rpg = this;
  let prior = null;

  console.log('plugin received registration:', user.id);
  console.log('map size:', Object.keys(rpg.map).length);

  try {
    prior = await rpg.db.get(user.id);
  } catch (E) {
    rpg.emit('warning', E);
  }

  if (prior) {
    rpg.map[user.id] = Object.assign({}, JSON.parse(prior), user);
  } else {
    rpg.map[user.id] = Object.assign({
      type: 'User'
    }, user);
  }

  await rpg.db.put(user.id, JSON.stringify(rpg.map[user.id]));
};

IdleRPG.prototype._registerChannel = async function registerChannel (channel) {
  if (channel.name === this.config.channel) {
    this.channel = channel;
  }
};

IdleRPG.prototype._handleMessage = async function handleMessage (message) {
  console.log('received message:', message);
};

// TODO: use Fabric for patch event handling
// temporary: fast-json-patch?
IdleRPG.prototype._handlePatch = async function (patch) {
  let rpg = this;
  let parts = patch.path.split('/');
  let collection = parts.slice(0, 2).join('/');
  let id = parts.slice(0, 3).join('/');

  switch (collection) {
    case 'slack/users':
      console.log(`received a patch to ${collection}:`, patch);
      rpg.map[id].online = patch.value;
      break;
  }
};

module.exports = IdleRPG;
