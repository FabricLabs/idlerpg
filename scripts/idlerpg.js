#!/usr/bin/env node
'use strict';

const Core = require('../types/core');

async function main () {
  let core = new Core();
  let process = await core.start();
  console.log('[IDLERPG]', 'process:', process);
  console.log('[IDLERPG]', 'Core is now running!');
}

module.exports = main();
