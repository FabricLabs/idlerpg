'use strict';

const fs = require('fs');
const util = require('util');
const level = require('level');
const mkdir = require('mkdirpsync');
const manager = require('fast-json-patch');

// artificial Fabric representation
// TODO: migrate to the real Fabric
function Fabric () {
  let self = this;
  this.state = { local: { users: {} } };
  this.services = {
    local: {
      _getUser: function (id) {
        return Object.assign({ id }, self.state.local.users[id]);
      },
      _getMembers: function () {
        return Object.keys(self.state.local.users).map(id => id);
      },
      _getPresence: function (id) {
        return self.state.local.users[id].presence;
      }
    }
  };
}

util.inherits(Fabric, require('events').EventEmitter);

Fabric.prototype._joinRoom = function (channel) {
  this.subscriptions.push(channel);
};

Fabric.prototype.patch = function applyPatch (patch) {
  manager.applyOperation(this.state, patch);
};

Fabric.prototype.applyPatches = function applyPatch (patches) {
  manager.applyPatch(this.state, patches);
};

Fabric.Store = function (config) {
  this.config = Object.assign({
    path: './data/fabric'
  }, config);

  if (!fs.existsSync(this.config.path)) fs.mkdir(this.config.path);

  this.db = level(this.config.path);
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

Fabric.Store.prototype.close = function () {
  return this.db.close();
};

Fabric.Store.prototype.flush = function () {
  if (fs.existsSync(this.config.path)) {
    fs.renameSync(this.config.path, this.config.path + '.' + Date.now());
  }
};

module.exports = Fabric;
