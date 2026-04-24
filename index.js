require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { addonBuilder } = require('stremio-addon-sdk')
const NodeCache = require('node-cache')
const axios = require('axios')
const logger = require('./logger')
const runExtractor = require('./unified-extractor')

const PORT = process.env.PORT || 7000
const SOURCES = ['wooflix', 'vilora', 'vidsrc', 'vidjoy', 'vidify']

const builder = new addonBuilder({
    id: 'org.streamvaults.resolver',
    version: '1.0.0',
    name: 'StreamVault',
    description: 'StreamVault stream resolver — movies and TV shows from multiple sources',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    logo: 'https://streamvaults.ru/favicon.ico',
    background: 'https://streamvaults.ru/og-image.jpg',
    idPrefixes: ['tt']
})

const streamCache = new NodeCache({ stdTTL: 7200, checkperiod: 120 })

async function fetchTmdbId(imdbId) {
    const apiKey = process.env.TMDB_API_KEY
    if (!apiKey) throw new Error('TMDB_API_KEY not set')
    const res = await axios.get(
        `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`
    )
    return res.data
}

async function resolveStreams(type, tmdbId, season, episode) {
    const cacheKey = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`
    const cached = streamCache.get(cacheKey)
    if (cached) {
        logger.info(`Cache hit: ${cacheKey}`)
        return cached
    }

    const results = await Promise.allSettled(
        SOURCES.map(s => runExtractor(s, type, String(tmdbId), season, episode))
    )

    const streams = {}
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value && Object.keys(r.value).length > 0) {
            Object.assign(streams, r.value)
        }
    }

    if (Object.keys(streams).length > 0) {
        streamCache.set(cacheKey, streams)
    }
    return streams
}

// Stremio stream handler (IMDB ID → TMDB ID → scrape)
builder.defineStreamHandler(async ({ type, id }) => {
    logger.info(`Stremio stream request: ${type} ${id}`)
    try {
        const [imdbId, season, episode] = id.split(':')
        const tmdbRes = await fetchTmdbId(imdbId)
        const tmdbId = type === 'movie'
            ? tmdbRes.movie_results[0]?.id
            : tmdbRes.tv_results[0]?.id
        if (!tmdbId) return { streams: [] }

        const stremioType = type === 'series' ? 'series' : 'movie'
        const streams = await resolveStreams(stremioType, tmdbId, season, episode)

        return {
            streams: Object.entries(streams).map(([name, url]) => ({
                name: `StreamVault | ${name}`,
                url,
                behaviorHints: { notWebReady: false }
            }))
        }
    } catch (e) {
        logger.error(`Stream handler error: ${e.message}`)
        return { streams: [] }
    }
})

const app = express()
app.use(cors())
app.use(express.static('public'))

// ── Stremio routes ────────────────────────────────────────────

app.get('/manifest.json', (req, res) => {
    res.json(builder.getInterface().manifest)
})

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const result = await builder.getInterface().get('stream', req.params.type, req.params.id)
        res.json(result)
    } catch (e) {
        res.json({ streams: [] })
    }
})

// ── Resolve API (used by StreamVault web player) ──────────────

app.get('/resolve/movie/:tmdbId', async (req, res) => {
    try {
        const streams = await resolveStreams('movie', req.params.tmdbId)
        res.json({ streams })
    } catch (e) {
        logger.error(`Resolve error: ${e.message}`)
        res.status(500).json({ streams: {}, error: 'Failed to resolve streams' })
    }
})

app.get('/resolve/tv/:tmdbId/:season/:episode', async (req, res) => {
    try {
        const { tmdbId, season, episode } = req.params
        const streams = await resolveStreams('series', tmdbId, season, episode)
        res.json({ streams })
    } catch (e) {
        logger.error(`Resolve error: ${e.message}`)
        res.status(500).json({ streams: {}, error: 'Failed to resolve streams' })
    }
})

// ── Embed pages (iframed by StreamVault) ─────────────────────

app.get('/embed/movie/:tmdbId', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(buildEmbedPage(`/resolve/movie/${req.params.tmdbId}`))
})

app.get('/embed/tv/:tmdbId/:season/:episode', (req, res) => {
    const { tmdbId, season, episode } = req.params
    res.setHeader('Content-Type', 'text/html')
    res.send(buildEmbedPage(`/resolve/tv/${tmdbId}/${season}/${episode}`))
})

// ── Health check ──────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        cache: { keys: streamCache.keys().length, stats: streamCache.getStats() }
    })
})

// ── Landing page ──────────────────────────────────────────────

app.get('/', (req, res) => {
    const host = req.headers.host || 'localhost'
    res.setHeader('Content-Type', 'text/html')
    res.send(buildLandingPage(host))
})

app.listen(PORT, '0.0.0.0', () => {
    logger.info(`StreamVault resolver running on port ${PORT}`)
})

// ── HTML builders ─────────────────────────────────────────────

function buildEmbedPage(resolveUrl) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamVault Player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  #player { width: 100%; height: 100%; display: none; }
  #state {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; color: #fff; font-family: system-ui, sans-serif;
  }
  .spinner {
    width: 48px; height: 48px;
    border: 3px solid rgba(168,85,247,0.2);
    border-top-color: #a855f7;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #msg { font-size: 14px; color: #a1a1aa; }
  #sources {
    position: absolute; top: 10px; right: 10px;
    display: flex; gap: 6px; z-index: 10; flex-wrap: wrap; justify-content: flex-end;
  }
  .src-btn {
    padding: 4px 10px; border-radius: 999px; border: none; cursor: pointer;
    font-size: 11px; font-weight: 600; transition: all 0.15s;
    background: rgba(255,255,255,0.1); color: #e4e4e7;
  }
  .src-btn.active { background: #a855f7; color: #fff; }
  .src-btn:hover:not(.active) { background: rgba(255,255,255,0.2); }
</style>
</head>
<body>
<video id="player" controls playsinline autoplay></video>
<div id="state">
  <div class="spinner"></div>
  <div id="msg">Resolving stream…</div>
</div>
<div id="sources"></div>

<script>
const video = document.getElementById('player')
const state = document.getElementById('state')
const msg = document.getElementById('msg')
const sourcesEl = document.getElementById('sources')
let hls = null
let streamUrls = []
let activeIdx = 0

function showError(text) {
  state.style.display = 'flex'
  video.style.display = 'none'
  state.innerHTML = '<div style="font-size:32px">⚠️</div><div style="color:#f87171;font-family:system-ui">' + text + '</div>'
}

function playUrl(url, idx) {
  activeIdx = idx
  document.querySelectorAll('.src-btn').forEach((b, i) => b.classList.toggle('active', i === idx))
  if (hls) { hls.destroy(); hls = null }
  if (url.includes('.m3u8') || url.includes('m3u8')) {
    if (Hls.isSupported()) {
      hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          const next = activeIdx + 1
          if (next < streamUrls.length) playUrl(streamUrls[next], next)
          else showError('All sources failed')
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      video.play().catch(() => {})
    }
  } else {
    video.src = url
    video.play().catch(() => {})
  }
  state.style.display = 'none'
  video.style.display = 'block'
}

function buildSourceButtons() {
  sourcesEl.innerHTML = streamUrls.map((_, i) =>
    '<button class="src-btn' + (i === activeIdx ? ' active' : '') + '" onclick="playUrl(streamUrls[' + i + '], ' + i + ')">S' + (i + 1) + '</button>'
  ).join('')
}

fetch('${resolveUrl}')
  .then(r => r.json())
  .then(data => {
    const entries = Object.entries(data.streams || {})
    if (!entries.length) { showError('No streams found'); return }
    streamUrls = entries.map(([, url]) => url)
    buildSourceButtons()
    playUrl(streamUrls[0], 0)
  })
  .catch(() => showError('Resolver unreachable'))

video.addEventListener('error', () => {
  const next = activeIdx + 1
  if (next < streamUrls.length) playUrl(streamUrls[next], next)
  else showError('All sources failed')
})
</script>
</body>
</html>`
}

function buildLandingPage(host) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamVault — Stremio Addon</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%);
    color: #fff; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    text-align: center; max-width: 440px; padding: 2.5rem 2rem;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px; backdrop-filter: blur(12px);
  }
  h1 { font-size: 2rem; font-weight: 700; margin-bottom: .5rem;
    background: linear-gradient(135deg, #a855f7, #ec4899);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  p { color: #a1a1aa; font-size: .95rem; line-height: 1.6; margin-bottom: 2rem; }
  .btn {
    display: inline-block; padding: .8rem 1.8rem;
    background: linear-gradient(135deg, #7c3aed, #a855f7);
    color: #fff; text-decoration: none; border-radius: 999px;
    font-weight: 600; font-size: .95rem;
    box-shadow: 0 4px 20px rgba(168,85,247,0.35);
    transition: transform .2s, box-shadow .2s;
  }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 28px rgba(168,85,247,0.5); }
  .info { margin-top: 1.5rem; color: #52525b; font-size: .8rem; }
  code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: .8rem; }
</style>
</head>
<body>
<div class="card">
  <h1>StreamVault</h1>
  <p>Add StreamVault to Stremio to stream movies and TV shows from multiple sources directly.</p>
  <a class="btn" href="stremio://${host}/manifest.json">Add to Stremio</a>
  <div class="info">
    Or paste <code>https://${host}/manifest.json</code> into Stremio manually
  </div>
</div>
</body>
</html>`
}
