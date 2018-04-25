# IdleRPG
Simple, self-playing game intended for chat servers.

## Getting Started
```js
const IdleRPG = require('idlerpg');
const game = new IdleRPG();

game.on('patch', function (change) {
  console.log('game state changed:', change);
});

game.start();
```

## API
IdleRPG uses a simple event
