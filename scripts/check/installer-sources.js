/* Read-only catalog verification against Microsoft's maintained WinGet manifests. */
const fs = require('fs');
const { CATALOG } = require('../../installers');
(async () => {
  const rows = [];
  for (const tool of CATALOG.filter(t => t.winget)) {
    const dir = `manifests/${tool.winget[0].toLowerCase()}/${tool.winget.split('.').join('/')}`;
    const listing = await fetch(`https://api.github.com/repos/microsoft/winget-pkgs/contents/${dir}`);
    if (!listing.ok) throw new Error(`${tool.id}: official manifest directory returned ${listing.status}`);
    const entries = (await listing.json()).filter(e => e.type === 'dir' && /^\d/.test(e.name));
    entries.sort((a,b) => b.name.localeCompare(a.name, undefined, {numeric:true}));
    const version = entries[0].name;
    const url = `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${dir}/${version}/${tool.winget}.yaml`;
    const response = await fetch(url);
    const manifest = await response.text();
    if (!response.ok || !manifest.includes(`PackageIdentifier: ${tool.winget}`)) throw new Error(`${tool.id}: identifier did not match`);
    rows.push({id:tool.id,packageId:tool.winget,manifestVersion:version,source:url});
    console.log(`PASS ${tool.winget}: identifier confirmed in Microsoft's catalog (${version})`);
  }
  fs.writeFileSync('audit/installer-sources.json',JSON.stringify({checkedOn:'2026-10-04',winget:rows},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
