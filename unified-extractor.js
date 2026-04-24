require('dotenv').config()
const axios = require('axios')
const { execFile } = require('child_process')
const logger = require('./logger')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
}

const sources = {
  vidsrc: (type, id, s, e) => type === 'movie'
    ? `https://vidsrc.xyz/embed/movie/${id}`
    : `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}`,
  vidsrcto: (type, id, s, e) => type === 'movie'
    ? `https://vidsrc.to/embed/movie/${id}`
    : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  vidlink: (type, id, s, e) => type === 'movie'
    ? `https://vidlink.pro/movie/${id}`
    : `https://vidlink.pro/tv/${id}/${s}/${e}`,
  autoembed: (type, id, s, e) => type === 'movie'
    ? `https://autoembed.co/movie/tmdb/${id}`
    : `https://autoembed.co/tv/tmdb/${id}-${s}-${e}`,
  embedsu: (type, id, s, e) => type === 'movie'
    ? `https://embed.su/embed/movie/${id}`
    : `https://embed.su/embed/tv/${id}/${s}/${e}`,
}

function extractStreamUrl(html) {
  const text = typeof html === 'string' ? html : JSON.stringify(html)

  // m3u8 first — highest quality indicator
  const m3u8 = text.match(/https?:\/\/[^\s"'\\<>]+\.m3u8(?:\?[^\s"'\\<>]*)?/g)
  if (m3u8) {
    const valid = m3u8.filter(u => u.length > 35 && !u.includes('example'))
    if (valid.length) return valid[0]
  }

  // mp4 fallback
  const mp4 = text.match(/https?:\/\/[^\s"'\\<>]+\.mp4(?:\?[^\s"'\\<>]*)?/g)
  if (mp4) {
    const valid = mp4.filter(u => u.length > 35)
    if (valid.length) return valid[0]
  }

  return null
}

async function axiosScrape(url) {
  try {
    const res = await axios.get(url, {
      headers: { ...HEADERS, 'Referer': 'https://www.google.com/' },
      timeout: 12000,
      maxRedirects: 5,
    })

    // Check direct response
    const direct = extractStreamUrl(res.data)
    if (direct) return direct

    // Some sites load an inner iframe — follow one level deep
    const iframeSrc = typeof res.data === 'string'
      ? (res.data.match(/(?:src|data-src)=["']([^"']+(?:embed|player|stream)[^"']+)["']/i) || [])[1]
      : null

    if (iframeSrc) {
      const inner = await axios.get(
        iframeSrc.startsWith('http') ? iframeSrc : new URL(iframeSrc, url).href,
        { headers: { ...HEADERS, 'Referer': url }, timeout: 10000, maxRedirects: 3 }
      ).catch(() => null)
      if (inner) return extractStreamUrl(inner.data)
    }

    return null
  } catch (e) {
    logger.warn(`axios failed [${url}]: ${e.message}`)
    return null
  }
}

function ytdlpExtract(url) {
  return new Promise(resolve => {
    execFile('yt-dlp', [
      '--get-url', '--no-playlist', '--no-check-certificate',
      '--user-agent', UA,
      '--socket-timeout', '15',
      '-f', 'best[height<=1080]/best',
      url,
    ], { timeout: 28000 }, (err, stdout) => {
      if (err) { logger.warn(`yt-dlp failed [${url}]: ${err.message}`); resolve(null); return }
      const lines = stdout.trim().split('\n').filter(l => l.startsWith('http'))
      resolve(lines[0] || null)
    })
  })
}

async function runExtractor(source, type, tmdbId, season, episode) {
  if (!sources[source]) throw new Error(`Unknown source: ${source}`)

  const url = sources[source](type, String(tmdbId), season, episode)
  logger.info(`Extracting [${source}] ${url}`)

  // 1 — axios + regex (fast, zero memory overhead)
  const axiosResult = await axiosScrape(url)
  if (axiosResult) {
    logger.info(`[${source}] axios hit: ${axiosResult.slice(0, 80)}`)
    return { [`${source} Link`]: axiosResult }
  }

  // 2 — yt-dlp fallback
  logger.info(`[${source}] axios miss — trying yt-dlp`)
  const ytResult = await ytdlpExtract(url)
  if (ytResult) {
    logger.info(`[${source}] yt-dlp hit: ${ytResult.slice(0, 80)}`)
    return { [`${source} Link`]: ytResult }
  }

  logger.warn(`[${source}] no stream found`)
  return {}
}

module.exports = runExtractor
