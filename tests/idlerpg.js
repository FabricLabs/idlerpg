'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events').EventEmitter;

const IdleRPG = require('../types/idlerpg');
const IdleRPGService = require('../services/idlerpg');
const Player = require('../types/player');

function tmpStore () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idlerpg-test-'));
}

function clock (start = 1760000000000) {
  let now = start;
  return {
    now: () => now,
    advance (ms) { now += ms; }
  };
}

describe('Player', function () {
  it('levels with experience', function () {
    assert.strictEqual(Player.levelForExperience(0), 1);
    assert.strictEqual(Player.levelForExperience(99), 1);
    assert.strictEqual(Player.levelForExperience(100), 2);
    const player = new Player({ id: 'a' });
    for (let i = 0; i < 10; i++) player.reward(1000);
    assert.strictEqual(player.experience, 100);
    assert.strictEqual(player.level, 2);
    assert.strictEqual(player.presenceMs, 10000);
  });

  it('penalizes by halving wealth', function () {
    const player = new Player({ id: 'a', wealth: 100 });
    assert.deepStrictEqual(player.penalize(), { notify: true });
    assert.strictEqual(player.wealth, 50);
    assert.deepStrictEqual(player.penalize(), { notify: false });
  });
});

describe('IdleRPG', function () {
  it('should expose a constructor', function () {
    assert(IdleRPG instanceof Function);
  });

  it('starts and stops without a configuration (in-memory)', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, verbosity: 0 });
    let ready = false;
    rpg.on('ready', () => { ready = true; });
    await rpg.start();
    assert(ready);
    await rpg.stop();
  });

  it('counts ticks on the clock', function (done) {
    const rpg = new IdleRPG({ persistent: false, interval: 5, verbosity: 0 });
    let count = 0;
    rpg.on('tick', async function () {
      if (++count === 10) {
        await rpg.stop();
        assert.strictEqual(rpg.report().totalTicks, 10);
        done();
      }
    });
    rpg.start();
  });

  it('credits present players and accumulates aggregate statistics', async function () {
    const time = clock();
    const rpg = new IdleRPG({ persistent: false, autostart: false, tickMs: 60000, luck: 0, now: time.now, verbosity: 0 });
    const announcements = [];
    rpg.on('message', (m) => announcements.push(m));
    await rpg.start();

    await rpg._registerUser({ id: 'discord/users/1', name: 'alice' });
    await rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/c1' });
    await rpg._handlePresence({ user: 'discord/users/2', status: 'online', channel: 'discord/channels/c1' });

    for (let i = 0; i < 3; i++) { time.advance(60000); await rpg.tick(); }
    let report = rpg.report();
    assert.strictEqual(report.presentNow, 2);
    assert.strictEqual(report.uniquePlayers, 2);
    assert.strictEqual(report.totalTicks, 3);
    assert.strictEqual(report.totalPresentHours, 0.1);
    assert.strictEqual(report.last7Days.players, 2);
    assert.strictEqual(report.last7Days.peak, 2);
    assert.ok(!JSON.stringify(report).includes('discord/users'), 'report must not leak user ids');

    await rpg._handlePart({ user: 'discord/users/1', channel: 'discord/channels/c1' });
    time.advance(60000); await rpg.tick();
    report = rpg.report();
    assert.strictEqual(report.presentNow, 1);
    assert.strictEqual(rpg.content.players['discord/users/1'].ticks, 3);
    assert.strictEqual(rpg.content.players['discord/users/2'].ticks, 4);
    assert.strictEqual(rpg.content.players['discord/users/1'].name, 'alice');
    assert.ok(announcements.some((m) => m.object.startsWith('Welcome to IdleRPG, alice')));
    await rpg.stop();
  });

  it('honors a channel allowlist', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, channels: ['idlerpg'], verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'local/users/a', channel: 'local/channels/general' });
    await rpg._handleJoin({ user: 'local/users/b', channel: 'local/channels/idlerpg' });
    assert.strictEqual(rpg.report().presentNow, 1);
    await rpg.stop();
  });

  it('penalizes chat in a game channel and ignores commands', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'local/users/a', channel: 'local/channels/idlerpg' });
    await rpg.tick();
    const before = rpg.content.players['local/users/a'].wealth;
    await rpg._handleMessage({ actor: 'local/users/a', target: 'local/channels/idlerpg', object: '!balance' });
    assert.strictEqual(rpg.content.players['local/users/a'].wealth, before);
    await rpg._handleMessage({ actor: 'local/users/a', target: 'local/channels/idlerpg', object: 'hello' });
    assert.strictEqual(rpg.content.players['local/users/a'].wealth, Math.floor(before / 2));
    await rpg.stop();
  });

  it('transfers wealth between players', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    await rpg._registerUser({ id: 'local/users/a', name: 'a', online: true });
    await rpg._registerUser({ id: 'local/users/b', name: 'b', online: true });
    await rpg.tick();
    const whispers = [];
    rpg.on('whisper', (w) => whispers.push(w));
    const reply = await rpg._handleTransferRequest({ actor: 'local/users/a', object: '!transfer 5 b', target: 'local/channels/x' });
    assert.strictEqual(reply, 'Balance transferred successfully!');
    assert.strictEqual(rpg.content.players['local/users/a'].wealth, 5);
    assert.strictEqual(rpg.content.players['local/users/b'].wealth, 15);
    assert.strictEqual(whispers[0].target, 'local/users/b');
    await rpg.stop();
  });

  it('persists to a Store and restores with everyone offline', async function () {
    const dir = tmpStore();
    const first = new IdleRPG({ path: dir, autostart: false, luck: 0, verbosity: 0 });
    await first.start();
    await first._handleJoin({ user: 'local/users/a', channel: 'local/channels/idlerpg' });
    await first.tick();
    await first.tick();
    await first.stop();

    const second = new IdleRPG({ path: dir, autostart: false, verbosity: 0 });
    await second.start();
    const report = second.report();
    assert.strictEqual(report.totalTicks, 2);
    assert.strictEqual(report.uniquePlayers, 1);
    assert.strictEqual(report.presentNow, 0);
    assert.strictEqual(second.content.players['local/users/a'].ticks, 2);
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('IdleRPGService', function () {
  it('binds to a host and answers triggers', async function () {
    const host = new EventEmitter();
    const service = new IdleRPGService({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    service.trust(host);
    await service.start();

    host.emit('join', { user: 'fake/users/alice', channel: 'fake/channels/idlerpg' });
    host.emit('presence', { user: 'fake/users/bob', status: 'online', channel: 'fake/channels/idlerpg' });
    await new Promise((resolve) => setImmediate(resolve));
    await service.tick();

    const online = await service.triggers.online.value({});
    assert.ok(online.includes('(2)'));
    const profile = await service.triggers.profile.value({ actor: 'fake/users/alice' });
    assert.ok(profile.includes('level **1**'));
    assert.strictEqual(service.report().presentNow, 2);

    host.emit('part', { user: 'fake/users/bob', channel: 'fake/channels/idlerpg' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(service.report().presentNow, 1);

    await service.stop();
    host.emit('join', { user: 'fake/users/carol', channel: 'fake/channels/idlerpg' });
    assert.strictEqual(service.report().presentNow, 1);
  });
});
