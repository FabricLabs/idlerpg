'use strict';

// TODO have Entity inherit from Fabric.Vector
const crypto = require('crypto');

function Entity (entity) {
  if (!entity) entity = { seed: Math.random() };

  this.id = entity.id || crypto.createHash('sha256').update(JSON.stringify(entity)).digest('hex');
  this.type = entity.type || 'Unknown';
  this.name = entity.name || this.id;

  this.experience = 0;

  this.equipment = {
    armor: null,
    weapon: null
  };

  this.stats = {
    strength: 0,
    luck: 0
  };

  this.effects = {};

  Object.assign(this, entity);

  return this;
}

Object.defineProperty(Entity.prototype, 'level', {
  get: function level () {
    if (this.experience) {
      return Math.floor(Math.log(this.experience / 10));
    } else {
      return 0;
    }
  }
});

Object.defineProperty(Entity.prototype, 'strength', {
  get: function strength () {
    return this.stats.strength;
  }
});

Object.defineProperty(Entity.prototype, 'luck', {
  get: function luck () {
    if (this.effects && this.effects.blessed) {
      return this.stats.luck * 2;
    } else {
      return this.stats.luck;
    }
  }
});

module.exports = Entity;
