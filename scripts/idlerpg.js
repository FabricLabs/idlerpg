#!/usr/bin/env node
'use strict';

const Core = require('../lib/core');

async function main () {
  let core = new Core();
  return core.start();
}

module.exports = main();
