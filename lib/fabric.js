'use strict';

const fs = require('fs');
const level = require('level');
const mkdir = require('mkdirpsync');
const pointer = require('json-pointer');
const manager = require('fast-json-patch');
const EventEmitter = require('events').EventEmitter;

class Service extends EventEmitter {
  constructor (config) {
    super(config);
    this.state = {};
  }

  trust (source) {
    source.on('patches', this.applyPatches.bind(this));
  }

  applyPatches (patches) {
    manager.applyPatch(this.state, patches);
  }

  _getUser (id) {
    return Object.assign({ id }, this.state.local.users[id]);
  }

  _getMembers () {
    return Object.keys(this.state.local.users).map(id => id);
  }

  _getPresence (id) {
    return this.state.local.users[id].presence;
  }
}

// artificial Fabric representation
// TODO: migrate to the real Fabric
class Fabric extends EventEmitter {
  constructor (config) {
    super(config);
    this.state = { local: { users: {} } };
    this.services = {
      local: new Service()
    };
  }
}

Fabric.prototype.trust = function trust (source) {
  source.on('patches', this.applyPatches.bind(this));
};

Fabric.prototype.replay = function replay (filename) {
  let path = `./data/${filename}`;
  if (!fs.existsSync(path)) throw new Error(`Could not find file: ${filename}`);

  try {
    let file = fs.readFileSync(path);
    let events = JSON.parse(file);
    for (let i = 0; i < events.length; i++) {
      this.emit(events[i].type, events[i]);
    }
  } catch (E) {
    console.error('[FABRIC]', 'could not read file.  possibly corrupt?');
  }
};

Fabric.prototype._joinRoom = function (channel) {
  this.subscriptions.push(channel);
};

Fabric.prototype.patch = function applyPatch (patch) {
  manager.applyOperation(this.state, patch);
};

Fabric.prototype.applyPatches = function applyPatch (patches) {
  manager.applyPatch(this.state, patches);
};

Fabric.prototype._GET = function get (path) {
  return pointer.get(this.state, path);
};

Fabric.prototype._PUT = function set (path, value) {
  return pointer.set(this.state, path, value);
};

Fabric.Store = function (config) {
  this.config = Object.assign({
    path: './data/fabric'
  }, config);

  if (!fs.existsSync(this.config.path)) mkdir(this.config.path);

  try {
    this.db = level(this.config.path);
  } catch (E) {
    console.error('Could not open datastore:', E);
  }

  this.map = {};

  return this;
};

Fabric.Store.prototype.get = async function (key) {
  this.map[key] = await this.db.get(key);
  return this.map[key];
};

Fabric.Store.prototype.set = async function (key, value) {
  await this.db.put(key, value);
  this.map[key] = value;
  return this.map[key];
};

Fabric.Store.prototype.batch = async function (ops, done) {
  return this.db.batch(ops).then(done);
};

Fabric.Store.prototype.close = async function () {
  await this.db.close();
  return this;
};

Fabric.Store.prototype.flush = function () {
  if (fs.existsSync(this.config.path)) {
    fs.renameSync(this.config.path, this.config.path + '.' + Date.now());
  }
};

module.exports = Fabric;
