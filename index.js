require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { addonBuilder } = require('stremio-addon-sdk')
const NodeCache = require('node-cache')
const axios = require('axios')
const logger = require('./logger')
const { resolveStream } = require('./stream-resolver')

const PORT = process.env.PORT || 7000

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
  idPrefixes: ['tt'],
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

async function getCachedStream(type, tmdbId, season, episode) {
  const key = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`
  const cached = streamCache.get(key)
  if (cached) { logger.info(`Cache hit: ${key}`); return cached }
  const result = await resolveStream(type, tmdbId, season, episode)
  if (result) streamCache.set(key, result)
  return result
}

// ── Stremio stream handler ────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
  logger.info(`Stremio: ${type} ${id}`)
  try {
    const [imdbId, season, episode] = id.split(':')
    const tmdbRes = await fetchTmdbId(imdbId)
    const tmdbId = type === 'movie' ? tmdbRes.movie_results[0]?.id : tmdbRes.tv_results[0]?.id
    if (!tmdbId) return { streams: [] }

    const host = process.env.PUBLIC_URL || 'https://streamvault-resolver.onrender.com'
    const embedUrl = type === 'series'
      ? `${host}/embed/tv/${tmdbId}/${season}/${episode}`
      : `${host}/embed/movie/${tmdbId}`

    // Try to resolve a direct stream first (fast cache hit)
    const streamType = type === 'series' ? 'series' : 'movie'
    const stream = await getCachedStream(streamType, tmdbId, season, episode)

    const streams = []

    if (stream?.url) {
      streams.push({
        name: 'StreamVault',
        title: 'Direct stream',
        url: stream.url,
        behaviorHints: { notWebReady: stream.type === 'hls' },
      })
    }

    // Always include the embed page as a fallback — opens in browser overlay in Stremio
    streams.push({
      name: 'StreamVault',
      title: 'Watch in browser',
      externalUrl: embedUrl,
    })

    return { streams }
  } catch (e) {
    logger.error(`Stremio handler error: ${e.message}`)
    return { streams: [] }
  }
})

const app = express()
app.use(cors())
app.use(express.static('public'))

// ── Stremio routes ────────────────────────────────────────────

app.get('/manifest.json', (req, res) => res.json(builder.getInterface().manifest))

app.get('/stream/:type/:id.json', async (req, res) => {
  try { res.json(await builder.getInterface().get('stream', req.params.type, req.params.id)) }
  catch { res.json({ streams: [] }) }
})

// ── Resolve API ───────────────────────────────────────────────

app.get('/resolve/movie/:tmdbId', async (req, res) => {
  try {
    const stream = await getCachedStream('movie', req.params.tmdbId)
    res.json(stream ?? { error: 'No stream found' })
  } catch (e) { res.status(500).json({ error: 'Resolver error' }) }
})

app.get('/resolve/tv/:tmdbId/:season/:episode', async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params
    const stream = await getCachedStream('series', tmdbId, season, episode)
    res.json(stream ?? { error: 'No stream found' })
  } catch (e) { res.status(500).json({ error: 'Resolver error' }) }
})

// ── Embed pages ───────────────────────────────────────────────

app.get('/embed/movie/:tmdbId', (req, res) => {
  const fallbacks = [
    { name: 'VidSrc',     url: `https://vidsrc.to/embed/movie/${req.params.tmdbId}` },
    { name: 'VidLink',    url: `https://vidlink.pro/movie/${req.params.tmdbId}` },
    { name: 'VidSrc XYZ', url: `https://vidsrc.xyz/embed/movie/${req.params.tmdbId}` },
    { name: 'AutoEmbed',  url: `https://autoembed.co/movie/tmdb/${req.params.tmdbId}` },
    { name: 'EmbedSu',    url: `https://embed.su/embed/movie/${req.params.tmdbId}` },
  ]
  res.setHeader('Content-Type', 'text/html')
  res.send(buildEmbedPage(`/resolve/movie/${req.params.tmdbId}`, fallbacks))
})

app.get('/embed/tv/:tmdbId/:season/:episode', (req, res) => {
  const { tmdbId, season, episode } = req.params
  const fallbacks = [
    { name: 'VidSrc',     url: `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: 'VidLink',    url: `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}` },
    { name: 'VidSrc XYZ', url: `https://vidsrc.xyz/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: 'AutoEmbed',  url: `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}` },
    { name: 'EmbedSu',    url: `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}` },
  ]
  res.setHeader('Content-Type', 'text/html')
  res.send(buildEmbedPage(`/resolve/tv/${tmdbId}/${season}/${episode}`, fallbacks))
})

// ── Health / landing ──────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  cache: { keys: streamCache.keys().length, stats: streamCache.getStats() },
}))

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(buildLandingPage(req.headers.host || 'localhost'))
})

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => logger.info(`StreamVault resolver on port ${PORT}`))
}

module.exports = { buildEmbedPage, buildLandingPage, app }

// ── HTML ──────────────────────────────────────────────────────

function buildEmbedPage(resolveUrl, fallbacks) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamVault Player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  #player{position:absolute;inset:0;width:100%;height:100%;display:none}
  #frame{position:absolute;inset:0;width:100%;height:100%;border:none;display:none}
  #overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#000;z-index:10;transition:opacity .4s}
  #overlay.hidden{opacity:0;pointer-events:none}
  .spinner{width:44px;height:44px;border:3px solid rgba(168,85,247,.2);border-top-color:#a855f7;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status{color:#71717a;font-size:13px;text-align:center;max-width:260px}
</style>
</head>
<body>
<div id="overlay"><div class="spinner"></div><div id="status">Finding best stream…</div></div>
<video id="player" controls playsinline></video>
<iframe id="frame" allowfullscreen allow="autoplay;encrypted-media;fullscreen;picture-in-picture"></iframe>

<script>
const FALLBACKS = ${JSON.stringify(fallbacks)}
const RESOLVE_URL = '${resolveUrl}'
const overlay = document.getElementById('overlay')
const status = document.getElementById('status')
const player = document.getElementById('player')
const frame = document.getElementById('frame')
let hls = null
let iframeIdx = 0
let iframeTimer = null

function setStatus(msg) { status.textContent = msg }
function hideOverlay() { overlay.classList.add('hidden') }

// ── Direct HLS/MP4 player ─────────────────────────────────────

function playDirect(url, type) {
  frame.style.display = 'none'
  player.style.display = 'block'
  clearIframeTimer()
  if (hls) { hls.destroy(); hls = null }

  if (type === 'hls') {
    if (Hls.isSupported()) {
      hls = new Hls()
      hls.loadSource(url)
      hls.attachMedia(player)
      hls.on(Hls.Events.MANIFEST_PARSED, () => { hideOverlay(); player.play().catch(()=>{}) })
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fallbackToIframe(0) })
    } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
      player.src = url
      player.oncanplay = () => { hideOverlay(); player.play().catch(()=>{}) }
      player.onerror = () => fallbackToIframe(0)
    } else { fallbackToIframe(0) }
  } else {
    player.src = url
    player.oncanplay = () => { hideOverlay(); player.play().catch(()=>{}) }
    player.onerror = () => fallbackToIframe(0)
  }
}

async function startDirect() {
  player.style.display = 'none'
  frame.style.display = 'none'
  overlay.classList.remove('hidden')
  setStatus('Finding best stream…')
  try {
    const res = await fetch(RESOLVE_URL)
    const data = await res.json()
    if (data.url) {
      playDirect(data.url, data.type || 'hls')
    } else {
      fallbackToIframe(0)
    }
  } catch {
    fallbackToIframe(0)
  }
}

// ── Iframe fallback ───────────────────────────────────────────

function clearIframeTimer() { if (iframeTimer) { clearTimeout(iframeTimer); iframeTimer = null } }

function loadIframe(idx) {
  if (idx >= FALLBACKS.length) {
    setStatus('All sources failed — try refreshing.')
    return
  }
  iframeIdx = idx
  clearIframeTimer()
  if (hls) { hls.destroy(); hls = null }
  player.style.display = 'none'
  frame.style.display = 'block'
  overlay.classList.remove('hidden')
  setStatus('Loading…')
  frame.src = FALLBACKS[idx].url
  iframeTimer = setTimeout(() => { if (!overlay.classList.contains('hidden')) loadIframe(idx + 1) }, 18000)
}

function fallbackToIframe(idx) { loadIframe(idx) }

frame.addEventListener('load', () => { clearIframeTimer(); hideOverlay() })

startDirect()
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
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0f0f1a,#1a1a2e);color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{text-align:center;max-width:440px;padding:2.5rem 2rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:24px}
  h1{font-size:2rem;font-weight:700;margin-bottom:.5rem;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#a1a1aa;font-size:.95rem;line-height:1.6;margin-bottom:2rem}
  .btn{display:inline-block;padding:.8rem 1.8rem;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;text-decoration:none;border-radius:999px;font-weight:600;box-shadow:0 4px 20px rgba(168,85,247,.35);transition:transform .2s}
  .btn:hover{transform:translateY(-2px)}
  .info{margin-top:1.5rem;color:#52525b;font-size:.8rem}
  code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:.8rem}
</style>
</head>
<body>
<div class="card">
  <h1>StreamVault</h1>
  <p>Add StreamVault to Stremio to stream movies and TV shows from multiple sources.</p>
  <a class="btn" href="stremio://${host}/manifest.json">Add to Stremio</a>
  <div class="info">Or paste <code>https://${host}/manifest.json</code> into Stremio</div>
</div>
</body>
</html>`
}
