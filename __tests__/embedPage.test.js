const { buildEmbedPage, buildLandingPage } = require('../index')

const FALLBACKS = [
  { name: 'VidSrc', url: 'https://vidsrc.to/embed/movie/27205' },
  { name: 'VidLink', url: 'https://vidlink.pro/movie/27205' },
]
const RESOLVE_URL = '/resolve/movie/27205'

describe('buildEmbedPage', () => {
  let html

  beforeAll(() => {
    html = buildEmbedPage(RESOLVE_URL, FALLBACKS)
  })

  test('returns a string', () => {
    expect(typeof html).toBe('string')
  })

  test('contains the video element with controls', () => {
    expect(html).toMatch(/<video[^>]*id="player"[^>]*controls/)
  })

  test('contains the iframe element with allowfullscreen', () => {
    expect(html).toMatch(/<iframe[^>]*id="frame"[^>]*allowfullscreen/)
  })

  test('contains the loading overlay', () => {
    expect(html).toContain('id="overlay"')
    expect(html).toContain('class="spinner"')
  })

  test('injects the resolve URL', () => {
    expect(html).toContain(`RESOLVE_URL = '${RESOLVE_URL}'`)
  })

  test('injects fallbacks as JSON', () => {
    expect(html).toContain(JSON.stringify(FALLBACKS))
  })

  test('does NOT contain a server switcher bar', () => {
    expect(html).not.toContain('id="bar"')
    expect(html).not.toContain('s-btn')
    expect(html).not.toContain('Servers:')
    expect(html).not.toContain('buildBar')
    expect(html).not.toContain('setActiveBtn')
  })

  test('does NOT show server names in visible UI', () => {
    // Fallback names must only appear inside the JSON data, not as UI labels
    const jsonStart = html.indexOf('const FALLBACKS =')
    const jsonEnd = html.indexOf('\n', jsonStart)
    const outsideJson = html.slice(0, jsonStart) + html.slice(jsonEnd)
    expect(outsideJson).not.toContain('VidSrc')
    expect(outsideJson).not.toContain('VidLink')
  })

  test('video and iframe have no z-index that would block controls', () => {
    // Neither #player nor #frame should have a z-index above the overlay (z-index:10)
    expect(html).not.toMatch(/#player[^{]*\{[^}]*z-index\s*:\s*[1-9]\d/)
    expect(html).not.toMatch(/#frame[^{]*\{[^}]*z-index\s*:\s*[1-9]\d/)
  })

  test('includes HLS.js CDN script', () => {
    expect(html).toContain('hls.js')
  })

  test('starts by calling startDirect()', () => {
    expect(html).toContain('startDirect()')
    // and NOT buildBar which would add the server switcher
    expect(html).not.toContain('buildBar(')
  })

  test('iframe fallback does not display server name in status', () => {
    // loadIframe used to show FALLBACKS[idx].name — now just shows "Loading…"
    expect(html).toContain("setStatus('Loading…')")
    expect(html).not.toMatch(/setStatus\('Loading ' \+ FALLBACKS/)
  })
})

describe('buildLandingPage', () => {
  let html

  beforeAll(() => {
    html = buildLandingPage('localhost:7000')
  })

  test('returns a string', () => {
    expect(typeof html).toBe('string')
  })

  test('contains Add to Stremio link with the provided host', () => {
    expect(html).toContain('stremio://localhost:7000/manifest.json')
  })

  test('shows manifest URL to paste', () => {
    expect(html).toContain('https://localhost:7000/manifest.json')
  })

  test('contains StreamVault branding', () => {
    expect(html).toContain('StreamVault')
  })
})
