'use strict';

// A minimal host: drive the IdleRPG engine directly, no chat network needed.
const IdleRPG = require('../types/idlerpg');
const yorick = require('./yorick');

const game = new IdleRPG({
  interval: 2000, // fast ticks for the demo
  path: './stores/simple'
});

async function main () {
  game.on('tick', (tick) => console.log('[EXAMPLES:SIMPLE]', 'tick:', tick));
  game.on('message', (msg) => console.log('[EXAMPLES:SIMPLE]', '[MESSAGE]', msg.object));

  await game.start();

  // Yorick walks into the game channel; every tick from now on rewards him.
  await game._registerUser({ id: `local/users/${yorick.name}`, name: yorick.name });
  await game._handleJoin({ user: `local/users/${yorick.name}`, channel: 'local/channels/idlerpg' });

  // ...and leaves after a few ticks.
  setTimeout(async () => {
    await game._handlePart({ user: `local/users/${yorick.name}`, channel: 'local/channels/idlerpg' });
    console.log('[EXAMPLES:SIMPLE]', 'report:', game.report());
    await game.stop();
  }, 9000);

  return game;
}

module.exports = main();
