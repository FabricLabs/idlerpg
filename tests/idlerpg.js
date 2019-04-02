'use strict';

const assert = require('assert');
const IdleRPG = require('../lib/idlerpg');

describe('IdleRPG', function () {
  it('should expose a constructor', function () {
    assert(IdleRPG instanceof Function);
  });

  it('should start without a configuration', function (done) {
    let rpg = new IdleRPG();

    rpg.on('ready', async function () {
      await rpg.stop();
      return done();
    });

    rpg.start();
  });

  it('should correctly count 10 ticks', function (done) {
    let rpg = new IdleRPG({ interval: 10 });
    let count = 0;

    rpg.on('tick', async function () {
      if (++count === 10) {
        await rpg.stop();
        return done();
      }
    });

    rpg.start();
  });

  it('should consume a series of events', function (done) {
    let count = 0;
    let rpg = new IdleRPG({
      interval: 0,
      channel: 'idlerpg',
      chance: 1
    });

    rpg.on('tick', async function () {

      if (++count === 10) {
        await rpg.stop();
        return done();
      }
    });

    async function main () {
      await rpg.start();

      rpg._registerUser({
        id: 'test',
        name: 'test',
        presence: 'online'
      });

      rpg.fabric.emit('join', {
        user: 'test',
        channel: 'idlerpg'
      });
    }

    main();
  });
});
