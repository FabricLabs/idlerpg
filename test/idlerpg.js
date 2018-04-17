'use strict';

const assert = require('assert');
const IdleRPG = require('../lib/idlerpg');

describe('IdleRPG', function () {
  it('should expose a constructor', function () {
    assert(IdleRPG instanceof Function);
  });
});
