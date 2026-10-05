const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
let count = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'release', 'dist', 'audit'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.[cm]?js$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
      count++;
    }
  }
}
walk(root);
console.log(`PASS syntax: ${count} JavaScript files`);
