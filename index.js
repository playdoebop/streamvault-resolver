require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { addonBuilder } = require('stremio-addon-sdk')
const NodeCache = require('node-cache')
const axios = require('axios')
const logger = require('./logger')
const runExtractor = require('./unified-extractor')

const PORT = process.env.PORT || 7000
const SOURCES = ['vidsrc', 'vidsrcto', 'vidlink', 'autoembed', 'embedsu']

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

async function resolveStreams(type, tmdbId, season, episode) {
  const cacheKey = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`
  const cached = streamCache.get(cacheKey)
  if (cached) { logger.info(`Cache hit: ${cacheKey}`); return cached }

  const results = await Promise.allSettled(
    SOURCES.map(s => runExtractor(s, type, String(tmdbId), season, episode))
  )
  const streams = {}
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) Object.assign(streams, r.value)
  }
  if (Object.keys(streams).length) streamCache.set(cacheKey, streams)
  return streams
}

builder.defineStreamHandler(async ({ type, id }) => {
  logger.info(`Stremio request: ${type} ${id}`)
  try {
    const [imdbId, season, episode] = id.split(':')
    const tmdbRes = await fetchTmdbId(imdbId)
    const tmdbId = type === 'movie' ? tmdbRes.movie_results[0]?.id : tmdbRes.tv_results[0]?.id
    if (!tmdbId) return { streams: [] }

    const streams = await resolveStreams(type === 'series' ? 'series' : 'movie', tmdbId, season, episode)
    return {
      streams: Object.entries(streams).map(([name, url]) => ({
        name: `StreamVault | ${name}`,
        url,
        behaviorHints: { notWebReady: false },
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

// ── Stremio ───────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => res.json(builder.getInterface().manifest))

app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    res.json(await builder.getInterface().get('stream', req.params.type, req.params.id))
  } catch { res.json({ streams: [] }) }
})

// ── Resolve API (Stremio / advanced use) ─────────────────────
app.get('/resolve/movie/:tmdbId', async (req, res) => {
  try {
    res.json({ streams: await resolveStreams('movie', req.params.tmdbId) })
  } catch (e) {
    res.status(500).json({ streams: {}, error: 'Resolver error' })
  }
})

app.get('/resolve/tv/:tmdbId/:season/:episode', async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params
    res.json({ streams: await resolveStreams('series', tmdbId, season, episode) })
  } catch (e) {
    res.status(500).json({ streams: {}, error: 'Resolver error' })
  }
})

// ── Embed pages — iframe cycler, no scraping ──────────────────
app.get('/embed/movie/:tmdbId', (req, res) => {
  const sources = [
    { name: 'VidSrc',     url: `https://vidsrc.to/embed/movie/${req.params.tmdbId}` },
    { name: 'VidLink',    url: `https://vidlink.pro/movie/${req.params.tmdbId}` },
    { name: 'VidSrc XYZ', url: `https://vidsrc.xyz/embed/movie/${req.params.tmdbId}` },
    { name: 'AutoEmbed',  url: `https://autoembed.co/movie/tmdb/${req.params.tmdbId}` },
    { name: 'EmbedSu',    url: `https://embed.su/embed/movie/${req.params.tmdbId}` },
    { name: '2Embed',     url: `https://www.2embed.cc/embed/${req.params.tmdbId}` },
  ]
  res.setHeader('Content-Type', 'text/html')
  res.send(buildEmbedPage(sources))
})

app.get('/embed/tv/:tmdbId/:season/:episode', (req, res) => {
  const { tmdbId, season, episode } = req.params
  const sources = [
    { name: 'VidSrc',     url: `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: 'VidLink',    url: `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}` },
    { name: 'VidSrc XYZ', url: `https://vidsrc.xyz/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: 'AutoEmbed',  url: `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}` },
    { name: 'EmbedSu',    url: `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}` },
    { name: '2Embed',     url: `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}` },
  ]
  res.setHeader('Content-Type', 'text/html')
  res.send(buildEmbedPage(sources))
})

// ── Health + landing ──────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  cache: { keys: streamCache.keys().length, stats: streamCache.getStats() },
}))

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(buildLandingPage(req.headers.host || 'localhost'))
})

app.listen(PORT, '0.0.0.0', () => logger.info(`StreamVault resolver on port ${PORT}`))

// ── HTML ──────────────────────────────────────────────────────

function buildEmbedPage(sources) {
  const srcJson = JSON.stringify(sources)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StreamVault Player</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}
  #frame{position:absolute;inset:0;width:100%;height:100%;border:none;opacity:0;transition:opacity .4s}
  #frame.ready{opacity:1}
  #overlay{
    position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:14px;
    background:#000;transition:opacity .4s;pointer-events:none;z-index:10
  }
  #overlay.hidden{opacity:0}
  .spinner{width:44px;height:44px;border:3px solid rgba(168,85,247,.2);border-top-color:#a855f7;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status{color:#71717a;font-size:13px}
  #bar{
    position:absolute;bottom:0;left:0;right:0;z-index:20;
    display:flex;align-items:center;gap:6px;padding:8px 10px;
    background:linear-gradient(to top,rgba(0,0,0,.85),transparent);
    opacity:0;transition:opacity .3s;flex-wrap:wrap
  }
  #bar:hover,body:hover #bar{opacity:1}
  #bar span{color:#71717a;font-size:11px;margin-right:2px}
  .s-btn{
    padding:3px 10px;border-radius:999px;border:none;cursor:pointer;
    font-size:11px;font-weight:600;background:rgba(255,255,255,.1);color:#e4e4e7;
    transition:background .15s
  }
  .s-btn.active{background:#a855f7;color:#fff}
  .s-btn:hover:not(.active){background:rgba(255,255,255,.2)}
  #err{color:#f87171;font-size:13px;display:none;text-align:center;padding:0 20px}
</style>
</head>
<body>
<div id="overlay"><div class="spinner"></div><div id="status">Loading player…</div><div id="err"></div></div>
<iframe id="frame" allowfullscreen allow="autoplay; encrypted-media; fullscreen; picture-in-picture"></iframe>
<div id="bar"><span>Servers:</span></div>

<script>
const SOURCES = ${srcJson}
const TIMEOUT_MS = 18000
let cur = 0, timer = null

const frame = document.getElementById('frame')
const overlay = document.getElementById('overlay')
const status = document.getElementById('status')
const errEl = document.getElementById('err')
const bar = document.getElementById('bar')

function buildButtons() {
  SOURCES.forEach((s, i) => {
    const b = document.createElement('button')
    b.className = 's-btn' + (i === 0 ? ' active' : '')
    b.textContent = s.name
    b.onclick = () => load(i)
    bar.appendChild(b)
  })
}

function setActive(i) {
  document.querySelectorAll('.s-btn').forEach((b, j) => b.classList.toggle('active', j === i))
}

function load(i) {
  if (i >= SOURCES.length) {
    errEl.textContent = 'All servers failed — try refreshing.'
    errEl.style.display = 'block'
    status.style.display = 'none'
    document.querySelector('.spinner').style.display = 'none'
    return
  }
  cur = i
  setActive(i)
  clearTimeout(timer)
  frame.classList.remove('ready')
  overlay.classList.remove('hidden')
  errEl.style.display = 'none'
  status.textContent = 'Loading ' + SOURCES[i].name + '…'
  frame.src = SOURCES[i].url
  timer = setTimeout(() => {
    if (!frame.classList.contains('ready')) load(i + 1)
  }, TIMEOUT_MS)
}

frame.addEventListener('load', () => {
  clearTimeout(timer)
  frame.classList.add('ready')
  overlay.classList.add('hidden')
})

buildButtons()
load(0)
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
  .btn{display:inline-block;padding:.8rem 1.8rem;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;text-decoration:none;border-radius:999px;font-weight:600;font-size:.95rem;box-shadow:0 4px 20px rgba(168,85,247,.35);transition:transform .2s}
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
  <div class="info">Or paste <code>https://${host}/manifest.json</code> into Stremio manually</div>
</div>
</body>
</html>`
}
