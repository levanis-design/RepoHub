const fs = require('fs');
const asar = require('@electron/asar');
const assert = require('assert/strict');
const crypto = require('crypto');

const archive = 'release/win-unpacked/resources/app.asar';
const files = fs.readdirSync('.').filter(f => f.endsWith('.js') || ['index.html', 'styles.css', 'icon.ico', 'icon.png'].includes(f));
for (const file of files) assert(fs.readFileSync(file).equals(asar.extractFile(archive, file)), file);
const sourcePackage = JSON.parse(fs.readFileSync('package.json'));
const packedPackage = JSON.parse(asar.extractFile(archive, 'package.json'));
for (const key of ['name', 'version', 'main', 'dependencies', 'engines']) assert.deepEqual(packedPackage[key], sourcePackage[key], key);
const entries = asar.listPackage(archive);
assert(!entries.some(f => /^\/(dev|tests|scripts|audit)\//.test(f)));
const artifacts = ['RepoHub-Setup-1.4.0.exe', 'RepoHub-1.4.0-portable.exe'].map(file => {
  const bytes = fs.readFileSync('release/' + file);
  return { file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
const result = { version: sourcePackage.version, unsigned: true, runtimeFilesMatched: files.length, archiveEntries: entries.length, artifacts };
fs.writeFileSync('audit/build-artifacts.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
