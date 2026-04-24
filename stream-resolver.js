require('dotenv').config()
const axios = require('axios')
const { execFile } = require('child_process')
const logger = require('./logger')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

// ── Source URL builders ───────────────────────────────────────

function getSources(type, tmdbId, imdbId, season, episode) {
  if (type === 'movie') {
    return [
      imdbId && `https://vidsrc.to/embed/movie/${imdbId}`,
      `https://vidsrc.xyz/embed/movie/${imdbId || tmdbId}`,
      `https://vidlink.pro/movie/${tmdbId}`,
      `https://embed.su/embed/movie/${tmdbId}`,
      `https://autoembed.co/movie/tmdb/${tmdbId}`,
    ].filter(Boolean)
  }
  return [
    imdbId && `https://vidsrc.to/embed/tv/${imdbId}/${season}/${episode}`,
    `https://vidsrc.xyz/embed/tv/${imdbId || tmdbId}/${season}/${episode}`,
    `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`,
    `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`,
    `https://autoembed.co/tv/tmdb/${tmdbId}-${season}-${episode}`,
  ].filter(Boolean)
}

// ── TMDB IMDB lookup ──────────────────────────────────────────

async function getImdbId(type, tmdbId) {
  try {
    const endpoint = type === 'movie'
      ? `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`
      : `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`
    const res = await axios.get(`${endpoint}?api_key=${process.env.TMDB_API_KEY}`, { timeout: 6000 })
    return res.data.imdb_id || null
  } catch {
    return null
  }
}

// ── Axios + regex scraper ─────────────────────────────────────

function extractStream(html) {
  const text = typeof html === 'string' ? html : JSON.stringify(html)
  const m3u8 = text.match(/https?:\/\/[^\s"'\\<>]+\.m3u8(?:\?[^\s"'\\<>]*)?/g)
  if (m3u8) {
    const valid = m3u8.filter(u => u.length > 40 && !u.includes('example'))
    if (valid.length) return { url: valid[0], type: 'hls' }
  }
  const mp4 = text.match(/https?:\/\/[^\s"'\\<>]+\.mp4(?:\?[^\s"'\\<>]*)?/g)
  if (mp4) {
    const valid = mp4.filter(u => u.length > 40)
    if (valid.length) return { url: valid[0], type: 'mp4' }
  }
  return null
}

async function tryAxios(url) {
  try {
    const res = await axios.get(url, {
      headers: { ...HEADERS, Referer: 'https://www.google.com/' },
      timeout: 10000, maxRedirects: 5,
    })
    const direct = extractStream(res.data)
    if (direct) return direct

    const iframeSrc = typeof res.data === 'string'
      ? (res.data.match(/(?:src|data-src)=["']([^"']+(?:embed|player|stream)[^"']+)["']/i) || [])[1]
      : null
    if (iframeSrc) {
      const inner = await axios.get(
        iframeSrc.startsWith('http') ? iframeSrc : new URL(iframeSrc, url).href,
        { headers: { ...HEADERS, Referer: url }, timeout: 8000, maxRedirects: 3 }
      ).catch(() => null)
      if (inner) return extractStream(inner.data)
    }
  } catch {}
  return null
}

// ── yt-dlp ────────────────────────────────────────────────────

function tryYtDlp(url, timeoutMs = 22000) {
  return new Promise(resolve => {
    execFile('yt-dlp', [
      '--get-url', '--no-playlist', '--no-check-certificate',
      '--user-agent', UA, '--socket-timeout', '12',
      '-f', 'best[height<=1080]/best', url,
    ], { timeout: timeoutMs }, (err, stdout) => {
      if (err) { resolve(null); return }
      const lines = stdout.trim().split('\n').filter(l => l.startsWith('http'))
      if (!lines[0]) { resolve(null); return }
      resolve({ url: lines[0], type: lines[0].includes('.m3u8') ? 'hls' : 'mp4' })
    })
  })
}

// ── vidlink direct API ────────────────────────────────────────

async function tryVidlinkApi(type, tmdbId) {
  try {
    const endpoint = type === 'movie'
      ? `https://vidlink.pro/api/b/movie/${tmdbId}`
      : null
    if (!endpoint) return null
    const res = await axios.get(endpoint, {
      headers: { ...HEADERS, Referer: 'https://vidlink.pro/' },
      timeout: 8000,
    })
    const d = res.data
    if (d?.stream?.playlist) return { url: d.stream.playlist, type: 'hls' }
    if (d?.stream?.url) return { url: d.stream.url, type: d.stream.type || 'hls' }
    // sometimes it's nested under data
    const s = d?.data?.stream || d?.results?.stream
    if (s?.playlist) return { url: s.playlist, type: 'hls' }
    if (s?.url) return { url: s.url, type: 'hls' }
    return extractStream(JSON.stringify(d))
  } catch {
    return null
  }
}

// ── Main resolver ─────────────────────────────────────────────

async function resolveStream(type, tmdbId, season, episode) {
  logger.info(`Resolving: ${type} tmdb:${tmdbId} s${season ?? '-'}e${episode ?? '-'}`)

  // Get IMDB ID for vidsrc.to (needs imdb id)
  const imdbId = await getImdbId(type, tmdbId)
  logger.info(`IMDB ID: ${imdbId || 'not found'}`)

  // Fast path: vidlink API (returns JSON directly)
  if (type === 'movie') {
    const vl = await tryVidlinkApi(type, tmdbId)
    if (vl) { logger.info(`vidlink API hit: ${vl.url.slice(0, 80)}`); return vl }
  }

  const sources = getSources(type, tmdbId, imdbId, season, episode)

  // Round 1: axios+regex on all sources (fast, ~10s each)
  for (const url of sources) {
    logger.info(`axios: ${url}`)
    const result = await tryAxios(url)
    if (result) { logger.info(`axios hit: ${result.url.slice(0, 80)}`); return result }
  }

  // Round 2: yt-dlp on each source (slower but reliable)
  for (const url of sources) {
    logger.info(`yt-dlp: ${url}`)
    const result = await tryYtDlp(url)
    if (result) { logger.info(`yt-dlp hit: ${result.url.slice(0, 80)}`); return result }
  }

  logger.warn(`All sources failed for ${type} tmdb:${tmdbId}`)
  return null
}

module.exports = { resolveStream }
