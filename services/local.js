'use strict';

const Fabric = require('@fabric/core');

class Local extends Fabric.Service {
  constructor (settings = {}) {
    super(settings);
    this.settings = Object.assign({}, settings);
    return this;
  }
}

module.exports = Local;
