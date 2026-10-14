'use strict';

const Engine = require('../types/idlerpg');

/**
 * Doorman-facing IdleRPG service. Binds a host's normalized adapter events
 * (`join`, `part`, `presence`, `user`, `channel`, `message`) to the game
 * engine, forwards engine announcements back to the host, and exposes the
 * engine's `!triggers` and `report()`.
 *
 * Usage: `doorman.use(require('idlerpg/services/idlerpg'), settings)`.
 */
class IdleRPGService extends Engine {
  static get pluginName () {
    return 'idlerpg';
  }

  constructor (settings = {}) {
    super(settings);
    this.host = null;
    this._hostListeners = {};
    return this;
  }

  /**
   * Subscribe to a host (Doorman or any EventEmitter speaking the adapter
   * event vocabulary).
   * @param {EventEmitter} host
   * @returns {IdleRPGService}
   */
  trust (host) {
    if (!host || typeof host.on !== 'function') throw new Error('Host must be an EventEmitter.');
    this.untrust();
    this.host = host;
    this._hostListeners = {
      join: (join) => this._handleJoin(join),
      part: (part) => this._handlePart(part),
      presence: (presence) => this._handlePresence(presence),
      user: (user) => this._registerUser(user),
      channel: (channel) => this._registerChannel(channel),
      message: (message) => this._handleMessage(message)
    };
    for (const [event, handler] of Object.entries(this._hostListeners)) {
      host.on(event, (payload) => {
        Promise.resolve(handler(payload)).catch((error) => {
          this.emit('error', `[IDLERPG] ${event}: ${error && error.message ? error.message : error}`);
        });
      });
      this._hostListeners[event] = host.listeners(event).slice(-1)[0];
    }
    return this;
  }

  untrust () {
    if (!this.host) return this;
    for (const [event, listener] of Object.entries(this._hostListeners)) {
      if (listener) this.host.removeListener(event, listener);
    }
    this._hostListeners = {};
    this.host = null;
    return this;
  }

  async stop () {
    this.untrust();
    return super.stop();
  }
}

module.exports = IdleRPGService;
