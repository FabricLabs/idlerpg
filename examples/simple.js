'use strict';

// Let's import some dependencies.
const IdleRPG = require('../types/idlerpg');
const game = new IdleRPG({ interval: 10000 });

// We'll join a player to the game, usually required to play.
const name = 'Yorick';

// Let's define our example program...
async function main () {
  // when the game's internal state changes, log some details to the console
  game.on('patches', function (patches) {
    console.log('[EXAMPLES:SIMPLE]', 'game state changed:', patches);
    console.log('[EXAMPLES:SIMPLE]', 'game state:', game.state);
  });

  game.on('message', function (msg) {
    console.log('[EXAMPLES:SIMPLE]', '[MESSAGE]', msg);
  });

  // when the game starts, add player and emulate some behavior
  game.on('ready', function () {
    // Let's replay some log events.
    game.replay('log.json');

    // Since we're just running locally, we'll need to connect a player to the
    // IdleRPG instance.  We'll also emulate some online/offline status changes,
    // demonstrating how IdleRPG reacts to various things.
    setInterval(async function () {
      // Should we be online?  Let's estimate 10% downtime.
      let status = (Math.random() > 0.1) ? 'online' : 'offline';
      // Normally, Fabric will broadcast these events when a service indicates
      // such a change.  Here, we manually change various properties.
      let link = `/users/local~1users~1${name}`;
      let patches = [
        { op: 'replace', path: `${link}/presence`, value: status },
        { op: 'replace', path: `${link}/online`, value: (status === 'online') }
      ];
      console.log('patches:', patches);
      game.fabric.emit('patches', patches);

      // Let's use the game's methods directly!  Here, we'll handle a transfer
      // request from Yorick to his friend.
      await game._handleTransferRequest({
        actor: 'Yorick',
        object: '!transfer 1 Friend',
        target: 'private',
        origin: {
          type: 'Link',
          name: 'local'
        }
      });
    }, 12000);
  });

  // start the game
  return game.start();
}

// run and export the main game loop
module.exports = main();
