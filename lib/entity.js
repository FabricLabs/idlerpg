'use strict';

const crypto = require('crypto');

function Entity(entity) {
    if (!entity) entity = { seed: Math.random() };

    this.id = entity.id || crypto.createHash('sha256').update(JSON.stringify(entity)).digest('hex');
    this.type = entity.type || 'Unknown';
    this.name = entity.name || this.id;

    this.EXP = 0;
    this.statPoints = 0;

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
    get: function attack() {

        derrivedStats.damage = stats.attack;

        return this.stats.attack;
    }
});

Object.defineProperty(Entity.prototype, 'agility', {
    get: function agility() {
        return this.stats.agility;
    }
});

Object.defineProperty(Entity.prototype, 'vitality', {
    get: function vitality() {

        derrivedStats.hp = (stats.vitality * 10);

        return this.stats.vitality;
    }
});

Object.defineProperty(Entity.prototype, 'invocation', {
    get: function invocation() {

        derrivedStats.mDamage = stats.invocation;

        return this.stats.invocation;
    }
});

Object.defineProperty(Entity.prototype, 'influence', {
    get: function influence() {

      derrivedStats.enchantments = 1 + (stats.influence);

        return this.stats.influence;
    }
});

Object.defineProperty(Entity.prototype, 'shielding', {
    get: function shielding() {

      derrivedStats.mhp = 1 + ((stats.shielding) * 5);

        return this.stats.shielding;
    }
});

Object.defineProperty(Entity.prototype, 'smarts', {
    get: function smarts() {

      derrivedStats.library = 10 + ((stats.smarts) * 5);

        return this.stats.smarts;
    }
});

Object.defineProperty(Entity.prototype, 'willpower', {
    get: function willpower() {

      derrivedStats.ap = 1 + stats.willpower;

        return this.stats.willpower;
    }
});

Object.defineProperty(Entity.prototype, 'charm', {
    get: function charm() {

      derrivedStats.summons = 1 + stats.charm;

        return this.stats.charm;
    }
});

module.exports = Entity;
