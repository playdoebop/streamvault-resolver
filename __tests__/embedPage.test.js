const { buildEmbedPage, buildLandingPage } = require('../index')

const FALLBACKS = [
  { url: 'https://vidlink.pro/movie/27205' },
  { url: 'https://autoembed.co/movie/tmdb/27205' },
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

  test('contains the loading overlay and spinner', () => {
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

  test('does NOT reference vidsrc.to (requires IMDB ID, not TMDB)', () => {
    // vidsrc.to needs tt... IMDB IDs — should not be in fallbacks built from TMDB ID
    const jsonBlock = html.match(/const FALLBACKS = (\[.*?\])/s)?.[1] || ''
    expect(jsonBlock).not.toContain('vidsrc.to')
  })

  test('video and iframe have no z-index that blocks controls', () => {
    expect(html).not.toMatch(/#player[^{]*\{[^}]*z-index\s*:\s*[1-9]\d/)
    expect(html).not.toMatch(/#frame[^{]*\{[^}]*z-index\s*:\s*[1-9]\d/)
  })

  test('includes HLS.js CDN script', () => {
    expect(html).toContain('hls.js')
  })

  test('boots with startDirect() not buildBar()', () => {
    expect(html).toContain('startDirect()')
    expect(html).not.toContain('buildBar(')
  })

  test('iframe load handler waits before hiding overlay', () => {
    // must use setTimeout to delay hide — not hide immediately on load
    expect(html).toContain('setTimeout(hideOverlay')
  })

  test('loadIframe shows generic status, not server names', () => {
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
