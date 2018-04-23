'use strict';

const util = require('util');
const monitor = require('fast-json-patch');

const Battle = require('./battle');
const Entity = require('./entity');

const random = function (items) {
  return items[Math.floor(Math.random() * items.length)];
};

const randomBetween = function (min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
};

const monsters = require('../data/monsters');
const rarities = require('../data/rarities');
const weapons = require('../data/weapons');

const MIN_LOOT_WORTH = 10;
const MAX_LOOT_WORTH = 30;

const MIN_ITEM_DURABILITY = 20;
const MAX_ITEM_DURABILITY = 50;

function Encounter (entity) {
  this.entity = new Entity(entity);
  this.state = {};

  // TODO: debug this observe issue (not emitting events!)
  // probably: https://github.com/Starcounter-Jack/JSON-Patch/issues/88
  // this.observer = monitor.observe(this.entity, this._observer.bind(this));
  this.observer = monitor.observe(this.entity);
  this.type = this._getType();

  this.compute();
}

util.inherits(Encounter, require('events').EventEmitter);

Encounter.prototype.compute = function () {
  switch (this.type) {
    case 'blessing':
      this.entity.health = 100;
      this.entity.stamina = 100;
      this.entity.effects['blessed'] = true;
      break;
    case 'monster':
      this.state.monster = new Entity(random(monsters));
      this.state.battle = new Battle([this.entity, this.state.monster]);

      // this.state.battle.compute();

      // TODO: compute wealth + experience from battle
      this.state.loot = randomBetween(MIN_LOOT_WORTH, MAX_LOOT_WORTH);
      this.entity.wealth += this.state.loot;
      break;
    case 'item':
      this.state.item = this._randomWeapon();
      if (!this.entity.weapon) {
        this.entity.weapon = this.state.item;
        this.state.equipped = true;
      } else if (this.entity.inventory.length < 5) {
        // TODO: automated inventory sorting
        this.entity.inventory.push(this.state.item);
      } else {
        this.state.skipped = true;
        this.entity.inventory = this.entity.inventory.slice(0, 4);
      }
      break;
  }

  this.patches = monitor.generate(this.observer);
};

Encounter.prototype._getType = function () {
  return random([
    'item',
    'item',
    'item',
    'monster',
    'monster',
    'blessing'
  ]);
};

Encounter.prototype._randomWeapon = function () {
  let template = random(weapons);
  let rarity = random(rarities);

  return Object.assign({}, template, {
    name: [rarity.name, template.name].join(' '),
    durability: randomBetween(MIN_ITEM_DURABILITY, MAX_ITEM_DURABILITY)
  });
};

Encounter.prototype._observer = function (patches) {
  console.log('observer saw:', patches);
};

module.exports = Encounter;
