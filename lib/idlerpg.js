'use strict';

const fs = require('fs');
const util = require('util');
const level = require('level');

const Encounter = require('./encounter');
const Fabric = require('./fabric');

const PER_TICK_CAPITAL = 10;
const TICK_INTERVAL = 600000;

function IdleRPG (config) {
  this.config = Object.assign({
    disk: './data',
    interval: TICK_INTERVAL
  }, config || {});

  this.channel = {};
  this.fabric = new Fabric();
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
  console.debug(`${new Date()}: Beginning tick...`);

  let rpg = this;

  for (let name in rpg.fabric.services) {
    let service = rpg.fabric.services[name];
    let members = await service._getMembers(rpg.config.channel);

    console.log('[IDLERPG]', `members of target room ${rpg.config.channel}:`, members);

    if (!members) continue;
    for (let i in members) {
      let id = [name, 'users', members[i]].join('/');
      let presence = await service._getPresence(members[i]);
      console.log(`presence for ${members[i]} (${rpg.map[id].name}) was ${presence}`);
      await this._registerUser({ id , presence });
    }
  }

  this.emit('tick');

  return rpg;
};

IdleRPG.prototype.start = function () {
  let rpg = this;

  // TODO: switch to Fabric's disk implementation
  if (!fs.existsSync(rpg.config.disk)) fs.mkdirSync(rpg.config.disk);
  rpg.db = level(rpg.config.disk + '/idlerpg');

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
  
  rpg.emit('ready');

  return rpg;
};

IdleRPG.prototype.stop = async function () {
  clearInterval(this.timer);
  return this.db.close();
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
  let rpg = this;
  let list = Object.keys(rpg.map).filter(x => {
    return rpg.map[x].type === 'User';
  }).filter(x => {
    return rpg.map[x].online === true;
  }).map(x => {
    return Object.assign({}, rpg.map[x], {
      '@data': null
    });
  });

  return `Current debug data for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._getOnline = function () {
  let rpg = this;

  return Object.keys(rpg.map).filter(x => {
    return rpg.map[x].type === 'User';
  }).filter(x => {
    return rpg.map[x].online === true;
  });
};

IdleRPG.prototype._listOnline = function () {
  let rpg = this;
  let list = rpg._getOnline().map(x => rpg.map[x].name);
  return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._listMembers = function () {
  let rpg = this;
  let list = Object.keys(rpg.map).filter(x => {
    return rpg.map[x].type === 'User';
  });

  return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(list, null, '  ')}\n\`\`\``;
};

IdleRPG.prototype._registerUser = async function registerUser (user) {
  let rpg = this;
  let prior = null;

  try {
    prior = await rpg.db.get(user.id);
  } catch (E) {
    rpg.emit('warning', E);
  }

  if (prior) {
    rpg.map[user.id] = Object.assign({}, JSON.parse(prior), user);
  } else {
    rpg.map[user.id] = Object.assign({
      id: user.id,
      type: 'User',
      name: user.name,
      inventory: [],
      wealth: 0
    }, user);
  }

  await rpg.db.put(user.id, JSON.stringify(rpg.map[user.id]));
};

IdleRPG.prototype._registerChannel = async function registerChannel (channel) {
  // console.log('[IDLERPG]', 'registering channel:', channel);
  if (channel['@data'].id === this.config.channel) {
    this.channel = channel;
  }
};

IdleRPG.prototype._handleMessage = async function handleMessage (message) {
  console.log('[IDLERPG]', 'received message:', message);
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
      rpg.map[id].online = patch.value;
      break;
    case 'matrix/users':
      console.log(`received a patch to ${collection}:`, patch);
      rpg.map[id].online = patch.value;
      break;
  }
};

module.exports = IdleRPG;
