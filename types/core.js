'use strict';

const IdleRPG = require('./idlerpg');

/**
 * Implements a single-process instance of IdleRPG.
 * @property {Object} config Current configuration.
 * @property {IdleRPG} game Current instance of IdleRPG.
 * @property {String} status
 */
class Core {
  /**
   * Standlone instance of IdleRPG.
   * @param  {Object} config Configuration object.  Passed through to IdleRPG.
   */
  constructor (config) {
    this.config = Object.assign({
      path: 'stores/idlerpg'
    }, config);
    this.game = new IdleRPG(this.config);
    this.status = 'ready';
  }

  /**
   * Begin computing.
   * @return {Promise} Resolves once compute is complete.
   */
  async start () {
    let core = this;

    // log out received messages
    core.game.on('message', function (msg) {
      console.log('[CORE:MESSAGE]', msg);
    });

    // allow messages from game to change Fabric
    core.game.on('ready', function () {
      // core.game.trust(core.game);
    });

    // start the game...
    await core.game.start();

    // return the results :)
    return core;
  }
}

module.exports = Core;
