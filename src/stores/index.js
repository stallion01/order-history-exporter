// To add a store: create its file in this folder and list it here.
// See CONTRIBUTING.md for the adapter interface.
globalThis.OHE.STORE_FILES = [
  'src/stores/amazon.js',
  'src/stores/walmart-family.js',
  'src/stores/walmart.js',
  'src/stores/samsclub.js',
  'src/stores/ebay.js',
  'src/stores/newegg.js',
  'src/stores/homedepot.js',
];

// Everything a store tab needs, in load order.
globalThis.OHE.CONTENT_FILES = [
  'src/lib/core.js',
  'src/lib/runner.js',
  'src/stores/index.js',
  ...globalThis.OHE.STORE_FILES,
];
