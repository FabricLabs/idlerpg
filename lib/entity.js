'use strict';

const crypto = require('crypto');

function Entity (entity) {
  if (!entity) entity = { seed: Math.random() };

  this.id = entity.id || crypto.createHash('sha256').update(JSON.stringify(entity)).digest('hex');
  this.type = entity.type || 'Unknown';
  this.name = entity.name || this.id;

  this.EXP = 0;
  this.statPoints = 15;

  this.stats = {
    attack: 0,
    agility: 0,
    vitality: 0,
    invocation: 0,
    influence: 0,
    shielding: 0,
    smarts: 0,
    willpower: 0,
    charm: 0
  };

  this.derrivedStats = {
    damage: 0,
    hp: 0,
    mDamage: 0,
    enchantments: 0,
    mHP: 0,
    library: 0,
    ap: 0,
    summons: 0
  };

  this.cardLibrary = {
    attackCards: 0,
    itemCards: 0,
    summonCards: 0,
    spellCards: 0,
    enchantCards: 0,
    leylineCards: 0
  };

  this.effects = {};

  Object.assign(this, entity);

  return this;
}

Object.defineProperty(Entity.prototype, 'attack', {
  get: function attack () {
    Entity.derrivedStats.damage = Entity.stats.attack;

    return Entity.stats.attack;
  }
});

Object.defineProperty(Entity.prototype, 'agility', {
  get: function agility () {
    return Entity.stats.agility;
  }
});

Object.defineProperty(Entity.prototype, 'vitality', {
  get: function vitality () {
    Entity.derrivedStats.hp = (Entity.stats.vitality * 10);
    return this.stats.vitality;
  }
});

Object.defineProperty(Entity.prototype, 'invocation', {
  get: function invocation () {
    Entity.derrivedStats.mDamage = Entity.stats.invocation;
    return this.stats.invocation;
  }
});

Object.defineProperty(Entity.prototype, 'influence', {
  get: function influence () {
    Entity.derrivedStats.enchantments = 1 + (Entity.stats.influence);
    return this.stats.influence;
  }
});

Object.defineProperty(Entity.prototype, 'shielding', {
  get: function shielding () {
    Entity.derrivedStats.mhp = 1 + ((Entity.stats.shielding) * 5);
    return this.stats.shielding;
  }
});

Object.defineProperty(Entity.prototype, 'smarts', {
  get: function smarts () {
    Entity.derrivedStats.library = 10 + ((Entity.stats.smarts) * 5);
    return this.stats.smarts;
  }
});

Object.defineProperty(Entity.prototype, 'willpower', {
  get: function willpower () {
    Entity.derrivedStats.ap = 1 + Entity.stats.willpower;
    return this.stats.willpower;
  }
});

Object.defineProperty(Entity.prototype, 'charm', {
  get: function charm () {
    Entity.derrivedStats.summons = 1 + Entity.stats.charm;
    return this.stats.charm;
  }
});

module.exports = Entity;
