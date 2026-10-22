'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events').EventEmitter;

const IdleRPG = require('../types/idlerpg');
const IdleRPGService = require('../services/idlerpg');
const Player = require('../types/player');
const items = require('@fabric/rpg/functions/items');
const { placeFor } = require('@fabric/rpg/functions/places');
const { TICK_INTERVAL } = require('@fabric/rpg/constants');

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

  it('levels on its own steeper curve', function () {
    assert.strictEqual(Player.experienceForLevel(2), 100);
    assert.strictEqual(Player.experienceForLevel(3), 314);
    assert.strictEqual(Player.experienceForLevel(100), Math.ceil(100 * Math.pow(99, 1.65)));
    for (const level of [2, 3, 50, 100, 1000]) {
      assert.strictEqual(Player.levelForExperience(Player.experienceForLevel(level)), level);
      assert.strictEqual(Player.levelForExperience(Player.experienceForLevel(level) - 1), level - 1);
    }
  });

  it('penalizes by halving wealth', function () {
    const player = new Player({ id: 'a', wealth: 100 });
    assert.deepStrictEqual(player.penalize(), { notify: true });
    assert.strictEqual(player.wealth, 50);
    assert.deepStrictEqual(player.penalize(), { notify: false });
  });

  it('earns one attribute point per level, rotating strength, dexterity, constitution', function () {
    const player = new Player({ id: 'a' });
    assert.deepStrictEqual([player.attributes.strength, player.attributes.dexterity, player.attributes.constitution], [10, 10, 10]);
    player.gain(Player.experienceForLevel(3));
    assert.strictEqual(player.level, 3);
    assert.deepStrictEqual([player.attributes.strength, player.attributes.dexterity, player.attributes.constitution], [11, 11, 10]);
  });

  it('migrates a record saved before attributes and gear', function () {
    const old = { id: 'a', name: 'alice', experience: 1000, wealth: 5, ticks: 100, inventory: [] };
    const player = new Player(old);
    assert.strictEqual(player.level, 5);
    assert.strictEqual(player.allocated, 5);
    assert.deepStrictEqual([player.attributes.strength, player.attributes.dexterity, player.attributes.constitution], [12, 11, 11]);
    assert.deepStrictEqual(player.equipment, {});
    assert.deepStrictEqual(player.battles, { won: 0, lost: 0 });
    const again = new Player(player.toObject());
    assert.deepStrictEqual(again.attributes, player.attributes);
  });

  it('loads gear saved before item levels at the player level', function () {
    const sword = { id: 'sword', count: 1, quality: 50, material: 'iron', durability: 135, durabilityMax: 135 };
    const player = new Player({ id: 'a', experience: 1000, equipment: { 'main-hand': sword }, inventory: [Object.assign({}, sword), { id: 'wool', count: 2 }] });
    assert.strictEqual(player.equipment['main-hand'].level, 5);
    assert.strictEqual(player.inventory[0].level, 5);
    assert.strictEqual(player.inventory[1].level, undefined);
    const leveled = items.stack('sword', { level: 2 });
    assert.strictEqual(new Player({ id: 'a', experience: 1000, equipment: { 'main-hand': leveled } }).equipment['main-hand'].level, 2);
  });

  it('wears only the humanoid kit and bags beast gear', function () {
    const collar = items.stack('spiked-collar', { quality: 90 });
    const player = new Player({ id: 'a', equipment: { collar, ring: items.stack('club') } });
    assert.deepStrictEqual(player.equipment, {});
    assert.strictEqual(player.actor.body, 'humanoid');
    assert.strictEqual(player.receive(collar).equipped, null);
    assert.deepStrictEqual(player.equipment, {});
    assert.strictEqual(player.inventory[0].id, 'spiked-collar');
  });

  it('equips better gear, bags the rest, and sells from a full bag', function () {
    const player = new Player({ id: 'a' });
    const club = items.stack('club', { quality: 50 });
    const sword = items.stack('sword', { quality: 50 });
    assert.strictEqual(player.receive(club).equipped.id, 'club');
    assert.strictEqual(player.weapon, 'Club');
    assert.strictEqual(player.receive(sword).equipped.id, 'sword');
    assert.deepStrictEqual(player.inventory.map((s) => s.id), ['club']);
    assert.strictEqual(player.receive(items.stack('club', { quality: 10 })).equipped, null);
    player.receive({ id: 'wool', count: 2 });
    player.receive({ id: 'wool', count: 1 });
    assert.strictEqual(player.inventory.find((s) => s.id === 'wool').count, 3);
    let sold = 0;
    for (let i = 0; i < 20; i++) sold += player.receive(items.stack('dagger', { quality: 50 })).sold;
    assert.strictEqual(player.inventory.length, 16);
    assert.ok(sold > 0);
    assert.strictEqual(player.wealth, sold);
  });

  it('records battles and costs wealth on defeat', function () {
    const player = new Player({ id: 'a', wealth: 100 });
    player.recordBattle(true, 'slime');
    assert.deepStrictEqual(player.recordBattle(false), { lost: 10 });
    assert.strictEqual(player.kills, 1);
    assert.deepStrictEqual(player.battles, { won: 1, lost: 1 });
    assert.deepStrictEqual(player.slain, { slime: 1 });
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
    assert.strictEqual(rpg.playerFor('discord/users/1').ticks, 3);
    assert.strictEqual(rpg.playerFor('discord/users/2').ticks, 4);
    assert.strictEqual(rpg.playerFor('discord/users/1').name, 'alice');
    assert.ok(announcements.some((m) => m.object.startsWith('Welcome to IdleRPG, alice')));
    await rpg.stop();
  });

  it('retains all daily history by default and prunes only when retentionDays is set', async function () {
    const DAY = 24 * 60 * 60 * 1000;
    for (const [retentionDays, expected] of [[undefined, 400], [30, 30]]) {
      const time = clock();
      const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, now: time.now, retentionDays, verbosity: 0 });
      await rpg.start();
      await rpg._registerUser({ id: 'local/users/a', name: 'a', online: true });
      for (let i = 0; i < 400; i++) { await rpg.tick(); time.advance(DAY); }
      assert.strictEqual(Object.keys(rpg.content.stats.days).length, expected);
      await rpg.stop();
    }
  });

  it('honors a channel allowlist', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, channels: ['idlerpg'], verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'local/users/a', channel: 'local/channels/general' });
    await rpg._handleJoin({ user: 'local/users/b', channel: 'local/channels/idlerpg' });
    assert.strictEqual(rpg.report().presentNow, 1);
    await rpg.stop();
  });

  it('counts only the configured presence sources', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, sources: ['channel'], verbosity: 0 });
    await rpg.start();
    await rpg._registerUser({ id: 'discord/users/1', name: 'talker', online: true });
    await rpg._handlePresence({ user: 'discord/users/2', status: 'online' });
    await rpg._handleMessage({ actor: 'discord/users/1', target: 'discord/channels/general', object: 'hello' });
    await rpg.tick();
    assert.strictEqual(rpg.report().presentNow, 0);
    assert.strictEqual(rpg.playerFor('discord/users/1'), null);
    await rpg._handleJoin({ user: 'discord/users/3', channel: 'discord/channels/voice' });
    await rpg.tick();
    assert.strictEqual(rpg.report().presentNow, 1);
    assert.strictEqual(rpg.playerFor('discord/users/3').ticks, 1);
    await rpg.stop();
  });

  it('keeps a text author present for textWindowMs after each message', async function () {
    const time = clock();
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, tickMs: 600000, textWindowMs: 900000, sources: ['text'], now: time.now, verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'local/users/a', channel: 'local/channels/voice' });
    await rpg._handleMessage({ actor: 'local/users/b', target: 'local/channels/general', object: '!profile' });
    await rpg._handleMessage({ actor: 'local/users/c', target: 'local/channels/general', object: 'hello' });
    assert.strictEqual(rpg.report().presentNow, 1);
    assert.strictEqual(rpg._placeFor(rpg.content.users['local/users/c']).key, placeFor('local/channels/general').key);
    time.advance(600000); await rpg.tick();
    time.advance(600000); await rpg.tick();
    const player = rpg.playerFor('local/users/c');
    assert.strictEqual(player.ticks, 1);
    assert.strictEqual(player.wealth, rpg.settings.perTickCapital);
    assert.strictEqual(rpg.report().presentNow, 0);
    assert.strictEqual(rpg.leaderboard(5)[0].online, false);
    await rpg.stop();
  });

  it('publishes announcements only to configured announcement targets', async function () {
    const announce = 'discord/channels/announce';
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, announcements: [announce], verbosity: 0 });
    const messages = [];
    rpg.on('message', (m) => messages.push(m));
    await rpg.start();
    await rpg._registerUser({ id: 'discord/users/1', name: 'alice' });
    await rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/voice' });
    assert.strictEqual(rpg.report().presentNow, 1);
    assert.ok(messages.length > 0);
    assert.ok(messages.every((m) => m.target === announce));
    assert.ok(messages.some((m) => m.object.startsWith('Welcome to IdleRPG, alice')));
    await rpg.stop();
  });

  it('welcomes a player once and never announces a service id', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    const messages = [];
    rpg.on('message', (m) => messages.push(m));
    await rpg.start();
    await Promise.all([
      rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/voice' }),
      rpg._handlePresence({ user: 'discord/users/1', status: 'online', channel: 'discord/channels/voice' })
    ]);
    const welcomes = messages.filter((m) => m.object.startsWith('Welcome to IdleRPG'));
    assert.strictEqual(welcomes.length, 1);
    assert.ok(welcomes[0].object.startsWith('Welcome to IdleRPG, Unknown pilot.'));
    assert.ok(!messages.some((m) => m.object.includes('discord/users')));
    await rpg.stop();
  });

  it('penalizes chat only in the announcement channel when one is set', async function () {
    const announce = 'discord/channels/announce';
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, announcements: [announce], verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/voice' });
    await rpg.tick();
    const before = rpg.playerFor('discord/users/1').wealth;
    await rpg._handleMessage({ actor: 'discord/users/1', target: 'discord/channels/elsewhere', object: 'hello' });
    assert.strictEqual(rpg.playerFor('discord/users/1').wealth, before);
    await rpg._handleMessage({ actor: 'discord/users/1', target: 'discord/channels/voice', object: 'hello from voice chat' });
    assert.strictEqual(rpg.playerFor('discord/users/1').wealth, before, 'a game channel is free once announcements are set');
    await rpg._handleMessage({ actor: 'discord/users/1', target: announce, object: 'hello' });
    assert.strictEqual(rpg.playerFor('discord/users/1').wealth, Math.floor(before / 2));
    await rpg.stop();
  });

  it('penalizes chat in a game channel and ignores commands', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    await rpg._handleJoin({ user: 'local/users/a', channel: 'local/channels/idlerpg' });
    await rpg.tick();
    const before = rpg.playerFor('local/users/a').wealth;
    await rpg._handleMessage({ actor: 'local/users/a', target: 'local/channels/idlerpg', object: '!balance' });
    assert.strictEqual(rpg.playerFor('local/users/a').wealth, before);
    await rpg._handleMessage({ actor: 'local/users/a', target: 'local/channels/idlerpg', object: 'hello' });
    assert.strictEqual(rpg.playerFor('local/users/a').wealth, Math.floor(before / 2));
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
    assert.strictEqual(rpg.playerFor('local/users/a').wealth, 5);
    assert.strictEqual(rpg.playerFor('local/users/b').wealth, 15);
    assert.strictEqual(whispers[0].target, 'local/users/b');
    await rpg.stop();
  });

  it('ticks on the shared @fabric/rpg world clock', function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, verbosity: 0 });
    assert.strictEqual(rpg.settings.tickMs, TICK_INTERVAL);
    assert.strictEqual(rpg.worldClock.interval, 600000);
  });

  it('runs seeded encounters: battles, loot, gear, and public announcements only', async function () {
    const run = async () => {
      const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 1, seed: 'test-world', now: clock().now, verbosity: 0 });
      const messages = [];
      rpg.on('message', (m) => messages.push(m.object));
      await rpg.start();
      await rpg._registerUser({ id: 'discord/users/1', name: 'alice' });
      await rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/idlerpg' });
      await rpg._handleJoin({ user: 'discord/users/2', channel: 'discord/channels/idlerpg' });
      for (let i = 0; i < 60; i++) await rpg.tick();
      const result = { messages, report: rpg.report(), leaderboard: rpg.leaderboard(), players: JSON.parse(JSON.stringify(rpg.content.players)) };
      await rpg.stop();
      return result;
    };

    const first = await run();
    const second = await run();
    assert.deepStrictEqual(first.players, second.players, 'same seed replays the same world');

    const { report, leaderboard, players, messages } = first;
    const place = placeFor('discord/channels/idlerpg').name;
    assert.ok(report.battles.total > 0);
    assert.strictEqual(report.kills, report.battles.won);
    assert.ok(report.slain.length > 0 && report.slain.length <= 5);
    assert.ok(report.slain.every((row) => row.name && row.count > 0));
    assert.ok(!JSON.stringify(report).includes('discord/users'));

    const alice = Object.values(players).find((p) => p.accounts.some((a) => a.service === 'discord' && a.id === '1'));
    assert.strictEqual(alice.kills, alice.battles.won);
    assert.ok(alice.kills > 0);
    assert.ok(Object.keys(alice.equipment).length > 0, 'loot was equipped');

    const row = leaderboard.find((r) => r.name === 'alice');
    assert.strictEqual(row.kills, alice.kills);
    assert.ok(row.weapon === null || typeof row.weapon === 'string');
    assert.ok(leaderboard.some((r) => r.name === 'Unknown pilot'));

    assert.ok(messages.some((m) => m.includes(` near ${place}`)));
    assert.ok(messages.some((m) => /^alice (slew|hunted) /.test(m)));
    assert.ok(!messages.some((m) => m.includes('discord/users')));
  });

  it('levels monsters around the player', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 1, levelRange: 1, levelOffset: 0.4, seed: 'levels', verbosity: 0 });
    await rpg.start();
    await rpg._registerUser({ id: 'local/users/a', name: 'alice', online: true });
    const levels = new Set();
    for (let i = 0; i < 200; i++) {
      const player = new Player({ id: 'local/users/a', name: 'alice', experience: 1000 });
      assert.strictEqual(player.level, 5);
      rpg.content.stats.totalTicks = i;
      const outcome = rpg._rollForEncounter(player);
      if (!outcome || outcome.type !== 'monster') continue;
      const center = player.level + 2 + (outcome.creature.unique ? 3 : 0);
      assert.ok(Math.abs(outcome.creature.level - center) <= 1, `level ${outcome.creature.level} vs ${center}`);
      if (!outcome.creature.unique) levels.add(outcome.creature.level);
    }
    await rpg.stop();
    assert.deepStrictEqual([...levels].sort((a, b) => a - b), [6, 7, 8]);
  });

  it('announces rare and legendary gear and equips it', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, announcements: ['local/channels/idlerpg'], verbosity: 0 });
    const messages = [];
    rpg.on('message', (m) => messages.push(m.object));
    await rpg.start();
    await rpg._registerUser({ id: 'local/users/a', name: 'alice', online: true });
    const player = new Player(rpg.playerFor('local/users/a'));

    rpg._applyEncounter(player, { type: 'item', item: items.stack('sword', { quality: 80, prefix: 'keen', suffix: 'bear' }), place: null });
    rpg._applyEncounter(player, { type: 'item', item: items.stack('leather-gauntlets', { suffix: 'fox' }), place: null });
    await rpg.stop();

    assert.ok(messages.includes('alice found a **Keen Sword of the Bear** (legendary).  Equipped: **Keen Sword of the Bear** (legendary).'));
    assert.ok(messages.some((m) => m.startsWith('alice found **Leather Gauntlets of the Fox**.')));
    assert.strictEqual(player.weapon, 'Keen Sword of the Bear');
    assert.strictEqual(player.equipment.gauntlets.suffix, 'fox');
  });

  it('gives each player an opaque id, with their chat account attached, that outlives renames', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    const add = (key, name, experience) => Object.assign(rpg._player(key, name), { experience });
    add('discord/users/1', 'Ace Pilot', 50);
    add('discord/users/2', 'ace pilot', 900);
    add('discord/users/3', 'Zoë', 10);
    add('discord/users/4', 'discord/users/4', 5000);
    const ace = rpg.playerFor('discord/users/2');
    assert.deepStrictEqual(ace.accounts, [{ service: 'discord', id: '2' }]);
    assert.strictEqual(rpg.playerFor('discord/users/4').name, null, 'a chat id is never kept as a name');

    const board = rpg.leaderboard();
    assert.deepStrictEqual(board.map((row) => row.name), ['Unknown pilot', 'ace pilot', 'Ace Pilot', 'Zoë']);
    const ids = board.map((row) => row.id);
    assert.ok(ids.every((id) => /^[0-9a-f]{16}$/.test(id)), 'player ids are opaque hex');
    assert.strictEqual(new Set(ids).size, ids.length, 'player ids are unique');
    const aceId = ids[1];
    assert.strictEqual(aceId, ace.id);

    rpg._player('discord/users/2', 'Renamed Ace');
    assert.strictEqual(rpg.leaderboard()[1].id, aceId, 'a rename keeps the player id');
    assert.strictEqual(rpg.profile(aceId).name, 'Renamed Ace');
    assert.strictEqual(rpg.profile(ids[0]).name, 'Unknown pilot');

    const player = new Player(ace);
    player.receive(items.stack('sword', { quality: 80, prefix: 'keen', suffix: 'bear' }));
    player.recordBattle(true, 'wolf');
    player.recordBattle(false);
    Object.assign(ace, player.toObject());

    const profile = rpg.profile(aceId.toUpperCase());
    assert.strictEqual(profile.name, 'Renamed Ace');
    assert.strictEqual(profile.id, aceId);
    assert.strictEqual(profile.rank, 2);
    assert.strictEqual(profile.players, 4);
    assert.strictEqual(profile.weapon, 'Keen Sword of the Bear');
    assert.deepStrictEqual(profile.battles, { won: 1, lost: 1, total: 2 });
    assert.strictEqual(profile.equipment[0].slot, 'main-hand');
    assert.strictEqual(profile.equipment[0].rarity, 'legendary');
    assert.ok(profile.equipment[0].damage > 0);
    assert.strictEqual(profile.slain[0].count, 1);
    assert.ok(profile.nextLevelExperience > profile.experience && profile.experience >= profile.levelExperience);
    assert.ok(!JSON.stringify(profile).includes('discord/users'), 'profile must not leak user ids');

    assert.strictEqual(rpg.profile('ace-pilot'), null, 'names do not find pages');
    assert.strictEqual(rpg.profile('discord/users/2'), null, 'chat accounts do not find pages');
    assert.strictEqual(rpg.profile('2'), null);
    assert.strictEqual(rpg.profile(''), null);
    await rpg.stop();
  });

  it('credits a player present on several accounts once', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    await rpg._registerUser({ id: 'discord/users/1', name: 'alice' });
    const player = rpg.linkAccount('discord/users/1', 'matrix/users/@alice:example.org');
    assert.deepStrictEqual(player.accounts, [{ service: 'discord', id: '1' }, { service: 'matrix', id: '@alice:example.org' }]);
    assert.strictEqual(rpg.playerFor('matrix/users/@alice:example.org'), player);

    await rpg._handleJoin({ user: 'discord/users/1', channel: 'discord/channels/c1' });
    await rpg._handleJoin({ user: 'matrix/users/@alice:example.org', channel: 'matrix/channels/c1' });
    await rpg.tick();
    assert.strictEqual(rpg.playerFor('discord/users/1').ticks, 1);
    assert.strictEqual(rpg.report().presentNow, 1);
    assert.strictEqual(rpg.report().uniquePlayers, 1);
    assert.strictEqual(rpg.report().history[29].players, 1);
    const [row] = rpg.leaderboard();
    assert.strictEqual(row.id, player.id, 'one page id for every linked account');
    assert.strictEqual(rpg.profile(player.id).name, 'alice');
    assert.ok(!/discord|matrix|@alice/.test(JSON.stringify([row, rpg.profile(player.id)])), 'no chat account ids');

    await rpg._handlePart({ user: 'discord/users/1', channel: 'discord/channels/c1' });
    assert.strictEqual(rpg.leaderboard()[0].online, true, 'still present on the other network');
    assert.strictEqual(rpg.linkAccount('discord/users/2', 'matrix/users/@alice:example.org'), null, 'an account belongs to one player');
    assert.strictEqual(rpg.playerFor('discord/users/2'), null);
    await rpg.stop();
  });

  it('beats a compact summary however large the game grows', async function () {
    const rpg = new IdleRPG({ persistent: false, autostart: false, luck: 0, verbosity: 0 });
    await rpg.start();
    for (let i = 0; i < 200; i++) {
      const player = new Player({ id: `discord/users/${i}`, name: `pilot ${i}`, experience: 5000 });
      for (let n = 0; n < 10; n++) player.receive(items.stack('sword', { quality: 80, prefix: 'keen', suffix: 'bear' }));
      rpg.content.players[player.id] = player.toObject();
    }
    assert.ok(JSON.stringify(rpg.content).length > 32768, 'state is past the wire limit');
    const errors = [];
    const beats = [];
    rpg.on('error', (error) => errors.push(error));
    rpg.on('beat', (beat) => beats.push(beat));
    rpg.beat();
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(beats.length, 1);
    const body = JSON.parse(beats[0].data);
    assert.strictEqual(body.state.players, 200);
    assert.ok(!beats[0].data.includes('discord/users'), 'beat carries no user ids');
    await rpg.stop();
  });

  it('migrates players saved under their chat id without losing what they tracked', async function () {
    const dir = tmpStore();
    const first = new IdleRPG({ path: dir, autostart: false, luck: 0, verbosity: 0 });
    await first.start();
    const sword = items.stack('sword', { quality: 80, prefix: 'keen', suffix: 'bear' });
    // The shape saved before players had remote accounts.
    first.content.players = {
      'local/users/a': {
        id: 'local/users/a', name: 'a', experience: 1000, wealth: 3, ticks: 50, presenceMs: 3000000,
        kills: 4, battles: { won: 4, lost: 1 }, slain: { wolf: 4 }, cooldown: 2,
        equipment: { 'main-hand': sword }, inventory: [items.stack('hide')],
        firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z'
      },
      'discord/users/7': { id: 'discord/users/7', name: 'discord/users/7', experience: 10, publicId: 'abcdef0123456789' }
    };
    first.content.stats.days['2026-01-01'] = { presentMs: 1200000, peak: 2, ticks: 1, players: { 'local/users/a': 1, 'discord/users/7': 1 } };
    await first.stop();

    const second = new IdleRPG({ path: dir, autostart: false, verbosity: 0 });
    await second.start();
    const a = second.playerFor('local/users/a');
    assert.match(a.id, /^[0-9a-f]{16}$/, 'a player id of its own');
    assert.deepStrictEqual(a.accounts, [{ service: 'local', id: 'a' }]);
    assert.strictEqual(a.name, 'a');
    for (const [field, value] of Object.entries({ experience: 1000, wealth: 3, ticks: 50, presenceMs: 3000000, kills: 4, cooldown: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' })) {
      assert.strictEqual(a[field], value, field);
    }
    assert.deepStrictEqual(a.battles, { won: 4, lost: 1 });
    assert.deepStrictEqual(a.slain, { wolf: 4 });
    assert.strictEqual(a.equipment['main-hand'].id, 'sword');
    assert.strictEqual(a.inventory[0].id, 'hide');
    assert.strictEqual(a.attributes.strength, 12, 'attributes filled in for the level');

    const unnamed = second.playerFor('discord/users/7');
    assert.match(unnamed.id, /^[0-9a-f]{16}$/);
    assert.notStrictEqual(unnamed.id, 'abcdef0123456789', 'old page ids are not kept');
    assert.ok(!('publicId' in second.content.players[unnamed.id]), 'old page ids are dropped from the save');
    assert.strictEqual(unnamed.name, null, 'a chat id is never kept as a name');
    assert.deepStrictEqual(unnamed.accounts, [{ service: 'discord', id: '7' }]);
    assert.deepStrictEqual(Object.keys(second.content.players).sort(), [a.id, unnamed.id].sort());
    assert.deepStrictEqual(Object.keys(second.content.stats.days['2026-01-01'].players).sort(), [a.id, unnamed.id].sort(), 'day buckets count players');
    assert.strictEqual(second.report().uniquePlayers, 2);
    assert.ok(second.content.stats.seed, 'a world seed is created and saved');
    await second.stop();

    const third = new IdleRPG({ path: dir, autostart: false, verbosity: 0 });
    await third.start();
    assert.strictEqual(third.playerFor('local/users/a').id, a.id, 'the player id is saved');
    assert.strictEqual(third.playerFor('local/users/a').experience, 1000);
    await third.stop();
    fs.rmSync(dir, { recursive: true, force: true });
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
    assert.strictEqual(second.playerFor('local/users/a').ticks, 2);
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
