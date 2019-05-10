#!/usr/bin/env node
'use strict';

const {
  HTTP_HOST
} = require('../constants');

const Core = require('../types/core');
const Fabric = require('@fabric/core');

async function main () {
  let core = new Core();
  let remote = new Fabric.Remote({ host: HTTP_HOST });
  let process = await core.start();

  console.log('[IDLERPG]', 'process:', process);
  console.log('[IDLERPG]', 'Core is now running!');
}

module.exports = main();
