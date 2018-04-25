'use strict';

const IdleRPG = require('../lib/idlerpg');
const game = new IdleRPG({ interval: 1000 });
const name = 'Yorick';

// primary runtime loop
async function main () {
  // when the game's internal state changes, log some details to the console
  game.on('patches', async function (patches) {
    console.log('game state changed:', patches);
    console.log('Poor Yorick is now:', await game._getProfile('local/users/Yorick'));
    // this.fabric.applyPatches(patches);
  });

  // when the game starts, add player and emulate some behavior
  game.on('ready', function () {
    // trust state modifications from ourselves
    game.fabric.trust(game);

    // emit a user, as if it came from an external source
    game.fabric.emit('user', {
      id: name,
      name: name
    });

    // add a player to the game (same username as we provided before)
    // note that this emulates a Doorman "join" event
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

  // start the game
  return game.start();
}

// run and export the main game loop
module.exports = main();
