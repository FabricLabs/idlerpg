'use strict';

// Simulate IdleRPG progression across every CPU core.
//
//   npm run simulate -- --players 1000 --years 5
//   npm run simulate -- --players 200 --days 90 --luck 0.1 --json
//
// Options: --players, --days | --years | --ticks, --seed, --luck,
// --level-range, --level-spread, --level-offset, --level-offset-max,
// --per-tick-experience, --experience-rate,
// --channels, --workers (default: CPU count), --json.

const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Simulator = require('../types/simulator');

function parse (argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) options[key] = true;
    else options[key] = isNaN(Number(next)) ? next : Number(next);
  }
  if (options.years != null) options.days = options.years * 365;
  return options;
}

function settingsFrom (options) {
  const settings = {};
  for (const key of ['players', 'days', 'ticks', 'seed', 'luck', 'levelRange', 'levelSpread', 'levelOffset', 'levelOffsetMax', 'perTickExperience', 'experienceRate', 'channels']) {
    if (options[key] != null) settings[key] = options[key];
  }
  return settings;
}

function shard (settings, from, to) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { settings, from, to } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`simulation worker exited with ${code}`));
    });
  });
}

async function main () {
  const options = parse(process.argv.slice(2));
  const settings = settingsFrom(options);
  const simulator = new Simulator(settings);
  const players = simulator.settings.players;
  if (options.workers != null && !(Number.isSafeInteger(options.workers) && options.workers > 0)) {
    console.error('--workers must be a positive integer');
    process.exit(1);
  }
  const workers = Math.max(1, Math.min(players, options.workers || os.availableParallelism()));
  const started = Date.now();

  const size = Math.ceil(players / workers);
  const shards = [];
  for (let from = 0; from < players; from += size) shards.push(shard(settings, from, Math.min(players, from + size)));
  const metrics = (await Promise.all(shards)).reduce((total, part) => Simulator.merge(total, part), {});

  if (options.json) {
    console.log(JSON.stringify(Object.assign({ settings: simulator.settings }, simulator.summarize(metrics)), null, 2));
  } else {
    console.log(simulator.format(metrics));
    console.log(`\n${workers} workers, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.error('[SIMULATE]', error);
    process.exitCode = 1;
  });
} else {
  const simulator = new Simulator(workerData.settings);
  parentPort.postMessage(simulator.run(workerData.from, workerData.to));
}
