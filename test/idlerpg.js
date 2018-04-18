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
      rpg.stop().then(done);
    });

    rpg.start();
  });

  it('should correctly count 10 ticks', function (done) {
    let rpg = new IdleRPG({ interval: 10 });
    let count = 0;

    rpg.on('tick', function () {
      if (++count === 10) {
        rpg.stop().then(done);
      }
    });

    rpg.start();
  });

  it('should consume a series of events', function (done) {
    let rpg = new IdleRPG({ interval: 10 });
    let count = 0;

    rpg.on('tick', function () {
      if (++count === 10) {
        rpg.stop().then(done);
      }
    });

    rpg.start();
  });

});
