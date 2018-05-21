'use strict';

const IdleRPG = require('../lib/idlerpg');
const game = new IdleRPG({ interval: 1000 });
const name = 'Yorick';

// primary runtime loop
async function main () {
  // when the game's internal state changes, log some details to the console
  game.on('patches', async function (patches) {
    console.log('game state changed:', patches);
    console.log('game state:', game.state);
    console.log('Poor Yorick:', game.state.local.users[name]);
    game.fabric.applyPatches(patches);
  });

  game.on('message', function (msg) {
    console.log('[MESSAGE]', msg);
  });

  // when the game starts, add player and emulate some behavior
  game.on('ready', function () {
    // configure local service
    game.fabric.emit('service', { name: 'local' });

    // add a player to the game
    game.fabric.emit('join', {
      user: name,
      channel: 'idlerpg'
    });

    // emulate online/offline activity changes
    setInterval(function () {
      let status = (Math.random() > 0.1) ? 'online' : 'offline';
      // emulate a status change
      // Normally, Fabric will broadcast these events when a service indicates
      // such a change.  Here, we manually change various properties.
      game.fabric.emit('patches', [
        { op: 'replace', path: `/local/users/${name}/presence`, value: status },
        { op: 'replace', path: `/local/users/${name}/online`, value: (status === 'online') }
      ]);
    }, 12000);
  });

  return game.start();
}

// run and export the main game loop
module.exports = main();
