# IdleRPG
[![Build Status](https://img.shields.io/travis/FabricLabs/idlerpg.svg?branch=master&style=flat-square)](https://travis-ci.org/FabricLabs/idlerpg)
[![Coverage Status](https://img.shields.io/coveralls/FabricLabs/idlerpg.svg?style=flat-square)](https://coveralls.io/r/FabricLabs/idlerpg)
[![Total Contributors](https://img.shields.io/github/contributors/FabricLabs/idlerpg.svg?style=flat-square)](https://github.com/FabricLabs/idlerpg/contributors)

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
4. `npm start`

## Examples
The simplest way to see IdleRPG in action is to join [`#idlerpg:roleplaygateway.com`][chat],
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
const friend = 'Friend';

async function main () {
  game.on('patches', function (patches) {
    game.fabric.applyPatches(patches);
  });

  game.on('message', function (msg) {
    console.log('[MESSAGE]', msg);
  });

  game.on('ready', function () {
    game.fabric.trust(game);
    game.fabric.replay('log.json');
  });

  return game.start();
}

module.exports = main();
```

This minimal program demonstrates the full IdleRPG loop using a "local" service,
including composing a local copy of the in-game state (stored in `game.fabric`).

### `idlerpg-bot`
[`idlerpg-bot`][bot] is a [[`doorman`](https://github.com/FabricLabs/doorman)]-
powered chatbot with good examples of how the underlying messaging layer
operates, as well as how to integrate IdleRPG into your own applications.

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

### Who is present
`sources` decides what makes a player present (and earn each tick):

- `channel` — in an allowed channel, from `join` / `part` / `presence` events
  that name one: voice channels on Discord, rooms on IRC or Matrix.
- `status` — online with no channel: a `presence` event without one, or a
  `user` marked `online`.
- `text` — posting a message in an allowed channel, which keeps its author
  present for `textWindowMs` (30 minutes) afterwards. For text-only
  communities; such messages are never penalized.

The default is `['channel', 'status']`. The Doorman Discord adapter marks
anyone who posts as online, so a Discord game that should only pay voice
presence sets `sources: ['channel']`.

For detailed documentation, see [the `docs` folder][docs].  Happy hacking!

## The World
IdleRPG's world comes from [`@fabric/rpg`][rpg]. The game ticks on its
10-minute world clock. Each present player earns wealth and
experience per tick, plus one attribute point per level (strength, dexterity,
and constitution in turn). Now and then (`luck`, 5% per tick) they meet
something: a creature from their channel's biome (its level drawn evenly
around a center `levelOffset` of the player's level above it, default 10%,
at most `levelOffsetMax` levels, default 15, across ± `levelRange`, default 2,
or ± `levelSpread` of it, default 10%, whichever is wider; lair beasts three
levels higher still), a piece of
gear of about their level, a hidden cache, or a deity's blessing (weighted
6, 2, 1, 1 by `encounterWeights`). Battles run automatically on the shared combat
rules. A win pays kill experience, the creature's loot, and whatever it wore.
The world holds 72 creatures, from sheep and goblins to griffins, wyverns,
and liches; tougher ones (orcs, ogres, yetis, wyverns) appear only once a
player reaches their `minLevel`. Better gear for one of a player's humanoid slots is equipped. Beast gear such
as collars and barding goes to the bag, and a full bag sells its cheapest
pieces. A loss costs 10% of wealth.
Gear may drop with a prefix or a suffix (rare, announced in bold) or, very
rarely, both (legendary); lair beasts guard hoards where these are likelier.
Every game channel is a named place with a biome, and encounters are seeded by
the world seed (`seed`, saved on first start), so a saved world replays the
same way.

There is no level cap: gear, creatures, and armor all scale with level, so
fights stay winnable and short at any level while each level takes a little
longer than the last. Reaching level `n + 1` takes `100 * n^1.65` experience
(`LEVEL_BASE_EXPERIENCE`, `LEVEL_EXPONENT`), which puts level 100 about three
months of continuous presence away. `perTickExperience` (10) and
`experienceRate` (1, a multiplier on kill and blessing experience) tune the
pace without moving anyone's level. Monsters run a little above the player
because the slower pace leaves time to gather gear; without that lead, fights
past level 20 would be won almost every time.

## Simulating
`npm run simulate` plays years of IdleRPG for many players at once — real
`Player`s meeting real encounters, with the idle ticks between encounters
skipped — across every CPU core. It prints win rate, fight length, gear, and
pace per level band, plus the days taken to reach each milestone level:

```
npm run simulate -- --players 1000 --years 1
npm run simulate -- --players 40 --years 10 --json
```

Options: `--players`, `--days` / `--years` / `--ticks`, `--seed`, `--luck`,
`--level-range`, `--level-spread`, `--level-offset`, `--level-offset-max`,
`--per-tick-experience`, `--experience-rate`, `--channels`, `--workers`,
`--json`. Results
depend only on the options, never on how players are split across workers.
`types/simulator.js` is the same engine as a library.

To develop against a local `@fabric/rpg` checkout at `../rpg`, run
`npm run link:rpg` (or set `FABRIC_RPG` to another path).

## Next Steps
IdleRPG is an experiment in _swarm computing_, as part of an effort to [create
a serverless web][fabric].  Game engines are complex programs, and this one is
a demonstration of how a distributed computer &amp; accompanying operating
system might replace the need for servers altogether.

If this is an idea you're interested in, come join [the Fabric
community][fabric-community]!

[bot]: https://github.com/FabricLabs/idlerpg-bot
[chat]: https://to.fabric.pub/#idlerpg:roleplaygateway.com
[doorman]: https://github.com/FabricLabs/doorman
[fabric-events]: https://dev.fabric.pub/docs
[docs]: docs
[fork-idlerpg]: https://github.com/FabricLabs/idlerpg#fork-destination-box
[fork-idlerpg-bot]: https://github.com/FabricLabs/idlerpg-bot#fork-destination-box
[fabric]: https://fabric.fm
[fabric-community]: https://fabric.pub
[rpg]: https://github.com/FabricLabs/rpg
