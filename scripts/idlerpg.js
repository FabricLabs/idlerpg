#!/usr/bin/env node
'use strict';

const Core = require('../types/core');

async function main () {
  let core = new Core();
  return core.start();
}

module.exports = main();
