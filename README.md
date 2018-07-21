# IdleRPG
Simple, self-playing game intended for chat servers.

## Getting Started
It is recommended to use `idlerpg-bot` to run IdleRPG as a useful service, which
can be accomplished as follows:

0. [Fork `idlerpg-bot` »][fork-idlerpg-bot]
1. `git clone git@github.com:YOUR_USERNAME/idlerpg-bot.git`
2. `cd idlerpg-bot`
3. `npm install`
4. `cp config.json.sample config.json` then open in editor and configure
5. `npm start`

Running IdleRPG on its own:

0. [Fork `idlerpg` »][fork-idlerpg-bot]
1. `git clone git@github.com:YOUR_USERNAME/idlerpg.git`
2. `cd idlerpg`
3. `npm install`
4. `node examples/simple.js`

## Examples
The simplest way to see IdleRPG in action is to join [`#idlerpg:verse.im`][chat],
which will automatically join you into the official public game session.  This
channel is powered by [`idlerpg-bot`][bot], a pre-configured bot for Discord,
Matrix, and Slack.

### Simple Example
In the `examples` directory, you can find the following sample program:

```js
'use strict';

const IdleRPG = require('idlerpg');
const game = new IdleRPG({ interval: 1000 });
const name = 'Yorick';

async function main () {
  game.on('patches', async function (patches) {
    game.fabric.applyPatches(patches);
  });

  game.on('message', function (msg) {
    console.log('[MESSAGE]', msg);
  });

  game.on('ready', function () {
    game.fabric.emit('service', { name: 'local' });
    game.fabric.emit('join', {
      user: name,
      channel: 'idlerpg'
    });
  });

  return game.start();
}

module.exports = main();
```

This minimal program demonstrates the full IdleRPG loop using a "local" service,
including composing a local copy of the in-game state (stored in `game.fabric`).

### `idlerpg-bot`
[`idlerpg-bot`][bot] is a [`doorman`]-powered chatbot with good examples of how
the underlying messaging layer operates, as well as how to integrate IdleRPG
into your own applications.

## API
IdleRPG uses [an event-driven API][fabric-events] to send messages between
entities tracked by the game state.

For example, registrations use the `join` event:

```js
game.fabric.emit('join', {
  user: name,
  channel: 'idlerpg'
});
```

For detailed documentation, see [the `docs` folder][docs].  Happy hacking!

## Next Steps
IdleRPG is an experiment in _swarm computing_, as part of an effort by [the
Verse team][verse-team] to [create a serverless web][fabric].  Game engines are
complex programs, but we're starting with our own ("`verse`") as a demonstration
of how a distributed computer &amp; accompanying operating system might replace
the need for servers altogether.

If this is an idea you're interested in, come join [the Fabric
community][fabric-community]!

[bot]: https://github.com/FabricLabs/idlerpg-bot
[chat]: https://chat.verse.im/#/room/#idlerpg:verse.im
[doorman]: https://github.com/FabricLabs/doorman
[fabric-events]: https://dev.fabric.pub/docs
[verse-team]: https://verse.im/people
[docs]: docs
[fork-idlerpg]: https://github.com/FabricLabs/idlerpg#fork-destination-box
[fork-idlerpg-bot]: https://github.com/FabricLabs/idlerpg-bot#fork-destination-box
[fabric]: https://fabric.fm
[fabric-community]: https://fabric.pub
