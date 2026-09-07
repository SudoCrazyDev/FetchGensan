// Monorepo Metro config.
//
// Metro does not follow workspace symlinks or watch outside the app folder
// by default, so a change in packages/core would not trigger a reload and
// an import of @fetch/ui would fail to resolve. Both are fixed here.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// With node-linker=hoisted there is one copy of each package; letting Metro
// walk up would risk resolving a second React and produce the "Invalid hook
// call" error that takes a day to diagnose.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
