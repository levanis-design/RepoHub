const { connect } = require('./cdp');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let count = 0;
async function check(label, fn) { await fn(); count++; console.log(`PASS ${label}`); }
(async () => {
  const c = await connect();
  try {
    await c.send('Runtime.enable');
    // The launcher must point every REPOHUB_* setting at an isolated fixture.
    const settingsFile = (await c.evaluate('hub.settings.get()')).file;
    assert.match(settingsFile, /audit[\\/]local[\\/]/i, 'Desktop test refuses real user settings');
    await c.evaluate('hub.settings.reset()'); await delay(250);
    await check('actual Electron preload and version', async () => assert.equal((await c.evaluate('hub.app.version()')).version, '1.4.0'));
    await check('Indigo default', async () => assert.equal((await c.evaluate('hub.settings.get()')).settings.colorTheme, 'indigo'));
    await check('floating Settings', async () => { await c.evaluate("document.querySelector('#settings-btn').click()"); await delay(1200); assert.equal(await c.evaluate("document.querySelector('#settings-dock').hidden"), false); });
    await check('settings search finds code font', async () => {
      await c.evaluate("(()=>{const e=document.querySelector('.set-search'); e.value='code font'; e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      assert.equal(await c.evaluate("[...document.querySelectorAll('.set-row')].filter(e=>!e.hidden&& !e.closest('.set-section').hidden).length"), 1);
    });
    await check('settings search empty results hides every section', async () => {
      await c.evaluate("(()=>{const e=document.querySelector('.set-search'); e.value='zzzz-no-matches'; e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      assert.equal(await c.evaluate("[...document.querySelectorAll('.set-section')].every(e=>e.hidden)"), true);
    });
    await c.evaluate("document.querySelector('.set-nav-btn').click()");
    await check('pinned Settings has readable width', async () => {
      await c.evaluate("[...document.querySelectorAll('.set-head button')].find(e=>e.textContent.includes('Pin')).click()"); await delay(500);
      assert.equal(await c.evaluate("document.body.classList.contains('settings-pinned')"), true);
      assert.ok(await c.evaluate("document.querySelector('#settings-dock').getBoundingClientRect().width >= 400"));
    });
    await check('day and night settings update the renderer', async () => {
      await c.evaluate("hub.settings.set({themeMode:'night',density:'compact',writeStyle:'technical',summaryLength:400})"); await delay(400);
      assert.equal(await c.evaluate("window.__repohub.S.settings.themeMode"), 'night');
      await c.evaluate("hub.settings.set({themeMode:'day'})"); await delay(250);
      assert.equal(await c.evaluate("window.__repohub.S.settings.themeMode"), 'day');
    });
    await check('README strips script and event handlers', async () => {
      const html = await c.evaluate("window.__repohub.md('<script>globalThis.bad=1</script><a href=\"javascript:alert(1)\" onclick=\"bad()\">x</a><img src=\"https://example.test/x.png\" onerror=\"bad()\">').innerHTML");
      assert.doesNotMatch(html, /<script|onclick|onerror|javascript:/i);
    });
    await check('README image privacy setting prevents all image elements', async () => {
      await c.evaluate("hub.settings.set({readmeImages:false})"); await delay(150);
      assert.equal(await c.evaluate("window.__repohub.md('![test](https://example.test/test.png)').querySelectorAll('img').length"), 0);
    });
    await check('installer detection lists all 17 catalog entries', async () => {
      const r = await c.evaluate('hub.installers.check()'); assert.equal(r.ok, true); assert.equal(r.tools.length, 17);
      fs.writeFileSync(path.resolve('audit/local/detection.json'), JSON.stringify(r, null, 2));
    });
    await check('preview rejects an unrelated local service', async () => assert.equal((await c.evaluate("hub.sandbox.preview('http://127.0.0.1:8888/','test')")).ok, false));
    await check('settings popout is a second actual Electron window', async () => {
      assert.equal((await c.evaluate('hub.settings.popout()')).ok, true); await delay(600);
      const p = await connect(9333, t => t.url.includes('view=settings'));
      try { assert.equal((await p.evaluate('hub.settings.get()')).settings.writeStyle, 'technical'); } finally { p.close(); }
      await c.evaluate('hub.settings.closePopout()');
    });
    await check('reload preserves saved settings', async () => {
      await c.send('Page.reload'); await delay(900);
      assert.equal((await c.evaluate('hub.settings.get()')).settings.writeStyle, 'technical');
    });
    await check('command palette opens with Ctrl+K', async () => {
      await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:2});
      await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:2});
      assert.equal(await c.evaluate("document.querySelector('#palette').hidden"), false);
      await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',windowsVirtualKeyCode:27});
    });
    await check('grid opens with Ctrl+G', async () => {
      await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'g',code:'KeyG',windowsVirtualKeyCode:71,modifiers:2});
      assert.equal(await c.evaluate("window.__repohub.S.sel.type"), 'grid');
    });
    await check('pinned Settings and 125% scale keep the grid toolbar inside its pane', async () => {
      await c.evaluate("hub.settings.set({settingsMode:'pinned',textSize:125,uiFont:'Arial, sans-serif',readingFont:'Georgia, serif',codeFont:'Consolas, monospace'})");
      await c.evaluate("document.querySelector('#settings-btn').click()"); await delay(250);
      const size = await c.evaluate("({client:document.querySelector('#main').clientWidth,scroll:document.querySelector('#main').scrollWidth,font:getComputedStyle(document.body).fontFamily})");
      assert.ok(size.scroll <= size.client, JSON.stringify(size)); assert.match(size.font,/Arial/);
    });
    const shot = await c.send('Page.captureScreenshot');
    fs.mkdirSync(path.resolve('audit/screenshots'),{recursive:true});
    fs.writeFileSync(path.resolve('audit/screenshots/desktop-grid.png'),Buffer.from(shot.data,'base64'));
    console.log(`Desktop checks: ${count} passed`);
  } finally { c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
