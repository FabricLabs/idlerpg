'use strict';

const util = require('util');

function Fabric () {
  this.subscriptions = [];
}

util.inherits(Fabric, require('events').EventEmitter);

Fabric.prototype._joinRoom = function (channel) {
  this.subscriptions.push(channel);
};

module.exports = Fabric;
