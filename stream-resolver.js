require('dotenv').config()
const axios = require('axios')
const { execFile } = require('child_process')
const logger = require('./logger')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

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

// ── yt-dlp ────────────────────────────────────────────────────

function tryYtDlp(url, timeoutMs = 20000) {
  return new Promise(resolve => {
    execFile('yt-dlp', [
      '--get-url', '--no-playlist', '--no-check-certificate',
      '--user-agent', UA, '--socket-timeout', '10',
      '-f', 'best[height<=1080]/best', url,
    ], { timeout: timeoutMs }, (err, stdout) => {
      if (err) { resolve(null); return }
      const lines = stdout.trim().split('\n').filter(l => l.startsWith('http'))
      if (!lines[0]) { resolve(null); return }
      resolve({ url: lines[0], type: lines[0].includes('.m3u8') ? 'hls' : 'mp4' })
    })
  })
}

// ── vidlink JSON API ──────────────────────────────────────────

async function tryVidlinkApi(type, tmdbId, season, episode) {
  try {
    const endpoint = type === 'movie'
      ? `https://vidlink.pro/api/b/movie/${tmdbId}`
      : `https://vidlink.pro/api/b/tv/${tmdbId}?s=${season}&e=${episode}`
    const res = await axios.get(endpoint, {
      headers: { 'User-Agent': UA, Referer: 'https://vidlink.pro/' },
      timeout: 8000,
    })
    const d = res.data
    // try common response shapes
    const playlist =
      d?.stream?.playlist ||
      d?.data?.stream?.playlist ||
      d?.results?.stream?.playlist ||
      d?.stream?.url ||
      d?.url ||
      null
    if (playlist && playlist.startsWith('http')) return { url: playlist, type: 'hls' }

    // last-resort: regex for any m3u8 in the JSON response
    const text = JSON.stringify(d)
    const m3u8 = text.match(/https?:\\?\/\\?\/[^\s"'\\<>]+\.m3u8(?:\?[^\s"'\\<>]*)?/)
    if (m3u8) {
      const clean = m3u8[0].replace(/\\+\//g, '/').replace(/\\\//g, '/')
      if (clean.length > 40) return { url: clean, type: 'hls' }
    }
  } catch {}
  return null
}

// ── Main resolver ─────────────────────────────────────────────

async function resolveStream(type, tmdbId, season, episode) {
  logger.info(`Resolving: ${type} tmdb:${tmdbId} s${season ?? '-'}e${episode ?? '-'}`)

  // 1. vidlink JSON API (zero scraping overhead, returns structured response)
  const vl = await tryVidlinkApi(type, tmdbId, season, episode)
  if (vl) { logger.info(`vidlink API hit: ${vl.url.slice(0, 80)}`); return vl }

  // 2. yt-dlp — try the two sources most likely to have yt-dlp extractors
  const imdbId = await getImdbId(type, tmdbId)
  const ytSources = type === 'movie'
    ? [
        imdbId && `https://vidsrc.to/embed/movie/${imdbId}`,
        `https://vidsrc.xyz/embed/movie/${imdbId || tmdbId}`,
      ].filter(Boolean)
    : [
        imdbId && `https://vidsrc.to/embed/tv/${imdbId}/${season}/${episode}`,
        `https://vidsrc.xyz/embed/tv/${imdbId || tmdbId}/${season}/${episode}`,
      ].filter(Boolean)

  for (const url of ytSources) {
    logger.info(`yt-dlp: ${url}`)
    const result = await tryYtDlp(url)
    if (result) { logger.info(`yt-dlp hit: ${result.url.slice(0, 80)}`); return result }
  }

  logger.info(`No direct stream found for ${type} tmdb:${tmdbId} — embed page will iframe-fallback`)
  return null
}

module.exports = { resolveStream }
