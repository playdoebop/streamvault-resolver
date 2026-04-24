require('dotenv').config()
const { makeProviders, makeStandardFetcher, targets } = require('@movie-web/providers')
const axios = require('axios')
const { execFile } = require('child_process')
const logger = require('./logger')

// ── movie-web providers (primary) ─────────────────────────────

const mwProviders = makeProviders({
  fetcher: makeStandardFetcher(fetch),
  target: targets.ANY,
  consistentIpForRequests: false,
})

async function fetchMovieMeta(tmdbId) {
  const res = await axios.get(
    `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`
  )
  return {
    type: 'movie',
    title: res.data.title,
    releaseYear: new Date(res.data.release_date).getFullYear(),
    tmdbId: String(tmdbId),
  }
}

async function fetchTvMeta(tmdbId, season, episode) {
  const [showRes, epRes, seasonRes] = await Promise.all([
    axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${process.env.TMDB_API_KEY}`),
    axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${process.env.TMDB_API_KEY}`),
    axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${process.env.TMDB_API_KEY}`),
  ])
  return {
    type: 'show',
    title: showRes.data.name,
    releaseYear: new Date(showRes.data.first_air_date).getFullYear(),
    tmdbId: String(tmdbId),
    episode: { number: Number(episode), tmdbId: String(epRes.data.id) },
    season: { number: Number(season), tmdbId: String(seasonRes.data.id) },
  }
}

function extractStreamFromOutput(output) {
  if (!output?.stream) return null
  const s = output.stream
  if (s.type === 'hls' && s.playlist) return { url: s.playlist, type: 'hls' }
  if (s.type === 'file' && s.qualities) {
    const best = s.qualities['1080'] || s.qualities['720'] || s.qualities['480'] || Object.values(s.qualities)[0]
    if (best?.url) return { url: best.url, type: 'mp4' }
  }
  return null
}

async function tryMovieWeb(media) {
  try {
    const output = await Promise.race([
      mwProviders.runAll({ media }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 28000)),
    ])
    const result = extractStreamFromOutput(output)
    if (result) logger.info(`movie-web hit [${output.sourceId}]: ${result.url.slice(0, 80)}`)
    return result
  } catch (e) {
    logger.warn(`movie-web failed: ${e.message}`)
    return null
  }
}

// ── axios + regex fallback ────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const IFRAME_SOURCES = {
  movie: (id) => [
    `https://vidsrc.xyz/embed/movie/${id}`,
    `https://vidsrc.to/embed/movie/${id}`,
    `https://vidlink.pro/movie/${id}`,
    `https://autoembed.co/movie/tmdb/${id}`,
    `https://embed.su/embed/movie/${id}`,
  ],
  series: (id, s, e) => [
    `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}`,
    `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
    `https://vidlink.pro/tv/${id}/${s}/${e}`,
    `https://autoembed.co/tv/tmdb/${id}-${s}-${e}`,
    `https://embed.su/embed/tv/${id}/${s}/${e}`,
  ],
}

function extractUrlFromHtml(html) {
  const text = typeof html === 'string' ? html : JSON.stringify(html)
  const m3u8 = text.match(/https?:\/\/[^\s"'\\<>]+\.m3u8(?:\?[^\s"'\\<>]*)?/g)
  if (m3u8) {
    const v = m3u8.filter(u => u.length > 35 && !u.includes('example'))
    if (v.length) return { url: v[0], type: 'hls' }
  }
  const mp4 = text.match(/https?:\/\/[^\s"'\\<>]+\.mp4(?:\?[^\s"'\\<>]*)?/g)
  if (mp4) {
    const v = mp4.filter(u => u.length > 35)
    if (v.length) return { url: v[0], type: 'mp4' }
  }
  return null
}

async function tryAxios(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.google.com/' },
      timeout: 10000, maxRedirects: 5,
    })
    const direct = extractUrlFromHtml(res.data)
    if (direct) return direct

    // follow one iframe level deep
    const iframeSrc = typeof res.data === 'string'
      ? (res.data.match(/(?:src|data-src)=["']([^"']+(?:embed|player|stream)[^"']+)["']/i) || [])[1]
      : null
    if (iframeSrc) {
      const inner = await axios.get(
        iframeSrc.startsWith('http') ? iframeSrc : new URL(iframeSrc, url).href,
        { headers: { 'User-Agent': UA, 'Referer': url }, timeout: 8000, maxRedirects: 3 }
      ).catch(() => null)
      if (inner) return extractUrlFromHtml(inner.data)
    }
  } catch {}
  return null
}

async function tryYtDlp(url) {
  return new Promise(resolve => {
    execFile('yt-dlp', [
      '--get-url', '--no-playlist', '--no-check-certificate',
      '--user-agent', UA, '--socket-timeout', '15',
      '-f', 'best[height<=1080]/best', url,
    ], { timeout: 25000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      const lines = stdout.trim().split('\n').filter(l => l.startsWith('http'))
      resolve(lines[0] ? { url: lines[0], type: lines[0].includes('.m3u8') ? 'hls' : 'mp4' } : null)
    })
  })
}

async function tryScrapers(type, tmdbId, season, episode) {
  const urls = type === 'movie'
    ? IFRAME_SOURCES.movie(tmdbId)
    : IFRAME_SOURCES.series(tmdbId, season, episode)

  for (const url of urls) {
    logger.info(`Trying axios: ${url}`)
    const result = await tryAxios(url)
    if (result) { logger.info(`axios hit: ${result.url.slice(0, 80)}`); return result }
  }

  // yt-dlp on first source as last resort
  logger.info('Trying yt-dlp fallback...')
  return tryYtDlp(urls[0])
}

// ── Main resolver ─────────────────────────────────────────────

async function resolveStream(type, tmdbId, season, episode) {
  logger.info(`Resolving stream: ${type} tmdb:${tmdbId} s${season ?? '-'}e${episode ?? '-'}`)

  // 1. movie-web providers (best quality, most sources)
  try {
    const media = type === 'movie'
      ? await fetchMovieMeta(tmdbId)
      : await fetchTvMeta(tmdbId, season, episode)

    const mwResult = await tryMovieWeb(media)
    if (mwResult) return mwResult
  } catch (e) {
    logger.warn(`TMDB meta fetch failed: ${e.message}`)
  }

  // 2. axios + yt-dlp scrapers
  return tryScrapers(type, tmdbId, season, episode)
}

module.exports = { resolveStream }
