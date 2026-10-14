'use strict';

// Copy to settings/local.js (gitignored) to configure the standalone engine.
module.exports = {
  path: 'stores/idlerpg',
  interval: 600000, // tick every 10 minutes
  luck: 0.05, // encounter chance per rewarded tick
  channels: [] // allowlist of channel names/ids; empty = every channel counts
};
