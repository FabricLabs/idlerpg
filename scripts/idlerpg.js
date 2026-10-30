#!/usr/bin/env node
'use strict';

// Standalone IdleRPG: runs the engine with no chat host attached. Useful for
// inspecting persisted state or replaying `data/*.json` event logs.
const fs = require('fs');
const path = require('path');
const IdleRPG = require('../types/idlerpg');

function loadSettings () {
  const file = path.resolve(__dirname, '../settings/local.js');
  if (fs.existsSync(file)) return require(file);
  return {};
}

async function main (settings = {}) {
  const rpg = new IdleRPG(settings);
  rpg.on('message', (message) => console.log('[IDLERPG:MESSAGE]', message.target, message.object));
  rpg.on('error', (error) => console.error('[IDLERPG:ERROR]', error));
  rpg.on('tick', (tick) => console.log('[IDLERPG:TICK]', tick));
  await rpg.start();
  console.log('[IDLERPG]', 'started:', rpg.report());
  return rpg;
}

if (require.main === module) {
  main(loadSettings()).catch((error) => {
    console.error('[IDLERPG]', 'fatal:', error);
    process.exit(1);
  });
}

module.exports = main;
