const { app, BrowserWindow, clipboard, Menu } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { build } = require('esbuild')

const scratch = mkdtempSync(join(tmpdir(), 'mkagent-browser-input-'))
app.setPath('userData', join(scratch, 'profile'))
app.whenReady().then(async () => {
  const bundle = join(scratch, 'browser-cdp.cjs')
  await build({
    entryPoints: [join(__dirname, '../browser-cdp.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    plugins: [{ name: 'test-logger', setup(builder) {
      // The input test must not load the real logger or its user configuration.
      builder.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: 'logger', namespace: 'test-logger' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-logger' }, () => ({ contents: 'export const mainLog = { info() {}, warn() {}, error() {}, debug() {} }' }))
    } }],
  })
  const { BrowserCDP } = require(bundle)
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'paste' }] }]))
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const wc = window.webContents
  const cdp = new BrowserCDP(wc)
  const load = async (script = '') => {
    await wc.loadURL('data:text/html,' + encodeURIComponent(`<input id="plain"><input id="secret" type="password"><script>${script}</script>`))
  }
  const focus = selector => wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  const type = text => cdp.typeText(text)
  const paste = async () => {
    assert.equal(await cdp.pressKey('v', [process.platform === 'darwin' ? 'meta' : 'control']), true)
  }
  const recordedType = async (selector, text) => {
    await focus(selector)
    return (await type(text)).browserInput
  }
  const fill = async (selector, value) => {
    const snapshot = await cdp.getAccessibilitySnapshot()
    const index = selector === '#secret' ? 1 : 0
    const ref = snapshot.nodes.filter(node => node.role === 'textbox')[index].ref
    return (await cdp.fillElement(ref, value)).browserInput
  }
  // Attaching to an already loaded page cannot claim that it observed all earlier handlers.
  await load('window.addEventListener("beforeinput", e => e.stopImmediatePropagation(), true)')
  await cdp.prepareInputTracking()
  assert.equal(await recordedType('#plain', 'hello'), 'unknown')
  await load()
  assert.equal(await recordedType('#plain', 'hello'), 'ordinary')
  assert.equal(await recordedType('#secret', 'pw'), 'password')
  assert.equal(await wc.executeJavaScript('document.querySelector("#plain").value'), 'hello')
  assert.equal(await fill('#plain', 'filled'), 'ordinary')
  assert.equal(await fill('#secret', 'secret'), 'password')
  assert.equal(await wc.executeJavaScript('plain.value'), 'filled')
  assert.equal(await fill('#plain', ''), 'ordinary')
  assert.equal(await wc.executeJavaScript('plain.value'), '')

  // Clearing can move focus before typing; settling still writes to the original password field.
  await load(`secret.addEventListener('input', () => plain.focus());`)
  await focus('#secret')
  assert.equal(await fill('#secret', 'fixture-secret'), 'password')
  assert.equal(await wc.executeJavaScript('secret.value'), 'fixture-secret')
  assert.equal(await wc.executeJavaScript('plain.value'), 'fixture-secret')

  // Synthetic site events can add uncertainty but cannot replace trusted input evidence.
  await load(`plain.addEventListener('beforeinput', e => {
    if (!e.isTrusted) return;
    e.preventDefault();
    plain.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
    plain.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });`)
  assert.equal(await recordedType('#plain', 'x'), 'unknown')


  // A later site listener cannot hide password input, even if focus ends on a plain field.
  await load(`window.addEventListener('beforeinput', e => e.stopImmediatePropagation(), true);
    secret.addEventListener('input', () => plain.focus());`)
  assert.equal(await recordedType('#secret', 'xy'), 'password')
  await load(`plain.addEventListener('keydown', () => secret.focus(), { once: true });
    secret.addEventListener('keyup', () => plain.focus());`)
  assert.equal(await recordedType('#plain', 'xy'), 'password')
  await load(`plain.addEventListener('beforeinput', () => plain.type = 'password');
    plain.addEventListener('input', () => plain.type = 'text');`)
  assert.equal(await recordedType('#plain', 'xy'), 'password')

  await load()
  await focus('#plain')
  clipboard.writeText('pasted text')
  const pasted = await cdp.recordInput(1, async () => {
    await paste()
  })
  assert.equal(pasted.browserInput, 'ordinary')
  assert.equal(await wc.executeJavaScript('plain.value'), 'pasted text')
  await focus('#secret')
  assert.equal((await cdp.recordInput(1, async () => {
    await paste()
  })).browserInput, 'password')

  await load(`window.events = [];
    for (const name of ['keydown', 'keyup', 'paste']) window.addEventListener(name, e => events.push(e.type));
    plain.addEventListener('keydown', e => e.preventDefault());`)
  await focus('#plain')
  assert.equal((await cdp.recordInput(1, paste)).browserInput, 'unknown')
  assert.equal(await wc.executeJavaScript('plain.value'), '')
  assert.deepEqual(await wc.executeJavaScript('events'), ['keydown', 'keyup'])

  await load(`plain.addEventListener('beforeinput', e => e.preventDefault());`)
  assert.equal(await recordedType('#plain', 'x'), 'unknown')
  await load()
  const navigated = await cdp.recordInput(1, async () => { await type('x'); await load() })
  assert.equal(navigated.browserInput, 'unknown')
  console.log('browser input: ordinary/password, focus/type changes, stopped events, paste and navigation passed')
  cdp.detach()
  window.destroy()
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
