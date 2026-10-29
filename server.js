import express from 'express';
import cors from 'cors';
import { Ytdl, chooseFormat } from '@distube/ytdl-core';
import { Innertube, UniversalCache } from 'youtubei.js';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKENS_FILE = path.join(__dirname, '.tokens.json');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const ytdl = new Ytdl();
let innertube = null;
let pendingAuthData = null;
let isLoggedIn = false;
let currentUserInfo = null;

// Cache for deciphered streams
const formatCache = new Map();
let guestInnertube = null;

async function getGuestInnertube() {
  if (guestInnertube) return guestInnertube;
  try {
    guestInnertube = await Innertube.create({
      cache: new UniversalCache(false),
    });
    return guestInnertube;
  } catch (err) {
    console.error('Failed to init guest innertube:', err);
    return null;
  }
}

function normalizeSongName(title) {
  if (!title) return '';
  const parts = title.split(/[-–—:]/);
  const core = parts.length > 1 ? parts[1] : parts[0];
  return core
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/official|music|video|audio|lyric|lirik|visualizer|live|remastered/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Initialize Innertube & OAuth
async function initInnertube() {
  if (innertube) return innertube;
  try {
    console.log('Initializing YouTube Innertube client with OAuth support...');
    innertube = await Innertube.create({
      cache: new UniversalCache(false),
    });

    // Check for saved tokens
    if (fs.existsSync(TOKENS_FILE)) {
      try {
        const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        console.log('Found saved Google tokens, restoring session...');
        await innertube.session.signIn(tokens);
        isLoggedIn = true;
        await loadUserInfo();
      } catch (err) {
        console.warn('Failed to restore saved Google session:', err.message);
      }
    }

    // Attach OAuth Event Listeners
    innertube.session.on('auth-pending', (data) => {
      console.log('🔑 Google Device Login pending. Code:', data.user_code);
      pendingAuthData = {
        userCode: data.user_code,
        verificationUrl: data.verification_url || 'https://www.google.com/device',
        expiresIn: data.expires_in,
      };
    });

    innertube.session.on('auth', async (data) => {
      console.log('✅ Google Device Login successful!');
      pendingAuthData = null;
      isLoggedIn = true;

      if (data.credentials) {
        try {
          fs.writeFileSync(TOKENS_FILE, JSON.stringify(data.credentials, null, 2));
        } catch (e) {
          console.warn('Failed to save credentials to disk:', e.message);
        }
      }

      await loadUserInfo();
    });

    innertube.session.on('auth-error', (err) => {
      console.error('❌ Google Auth Error:', err.message);
      pendingAuthData = null;
      isLoggedIn = false;
    });

    return innertube;
  } catch (err) {
    console.error('Innertube initialization error:', err);
    return null;
  }
}

async function loadUserInfo() {
  if (!innertube) return;
  try {
    const acc = await innertube.account.getInfo();
    const items = acc?.contents?.contents || [];
    const active = items.find((i) => i.is_selected) || items[0];
    currentUserInfo = {
      name: active?.account_name?.text || 'Google Account',
      avatar: active?.account_photo?.[0]?.url || '',
      email: active?.account_byline?.text || '',
    };
  } catch {
    currentUserInfo = { name: 'Google Account', avatar: '', email: '' };
  }
}

// Start Innertube on boot
initInnertube();

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'YMusic Web Backend', timestamp: Date.now() });
});

// Autocomplete suggestions
app.get('/api/suggest', async (req, res) => {
  try {
    const q = req.query.q?.toString().trim();
    if (!q) return res.json({ suggestions: [] });

    const suggestions = await ytdl.getSuggestions(q);
    res.json({ suggestions: suggestions || [] });
  } catch (err) {
    console.error('Error in suggest:', err.message);
    res.json({ suggestions: [] });
  }
});

function mapTrackItem(item) {
  const thumbs = item.thumbnails || [];
  const thumbnail =
    thumbs[thumbs.length - 1]?.url ||
    thumbs[0]?.url ||
    `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  const durSec = item.lengthSeconds || item.durationSec || 0;
  return {
    id: item.id,
    title: item.title || item.name || 'Untitled',
    artist: item.author?.name || 'Unknown Artist',
    duration: formatDuration(durSec),
    durationSeconds: durSec,
    thumbnail,
    views: item.viewCount ? `${parseInt(item.viewCount, 10).toLocaleString()} views` : '',
  };
}

// Search with pagination
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q?.toString().trim();
    if (!q) return res.json({ results: [] });

    const page = parseInt(req.query.page || '1', 10);
    const limit = 35;
    const fetchLimit = page * limit;

    const searchResults = await ytdl.search(q, { type: 'video', limit: fetchLimit });
    const list = Array.isArray(searchResults) ? searchResults : searchResults?.items || [];
    const startIndex = (page - 1) * limit;
    const items = list.slice(startIndex, startIndex + limit).map(mapTrackItem);

    res.json({ results: items, page, hasMore: list.length >= startIndex + limit });
  } catch (err) {
    console.error('Error in search:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// Trending / Viral Charts with pagination
app.get('/api/trending', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const trendingQueries = [
      'Trending Musik Indonesia 2026',
      'Top Hits Spotify Indonesia',
      'Billboard Hot 100 2026',
      'Lagu Viral Tiktok Terbaru',
    ];
    const q = trendingQueries[(page - 1) % trendingQueries.length];
    const searchResults = await ytdl.search(q, { type: 'video', limit: 40 });
    const list = Array.isArray(searchResults) ? searchResults : searchResults?.items || [];
    const items = list.slice(0, 35).map(mapTrackItem);

    res.json({ results: items, page, hasMore: true });
  } catch (err) {
    console.error('Error in trending:', err.message);
    res.status(500).json({ error: 'Failed to fetch trending', details: err.message });
  }
});

// Discover / Category Hub with pagination
app.get('/api/discover', async (req, res) => {
  try {
    const category = req.query.category || 'all';
    const page = parseInt(req.query.page || '1', 10);

    const categoryQueries = {
      all: ['Lagu Hits Indonesia Populer 2026', 'Best Indonesian Songs Playlist', 'Top Hits Spotify 2026'],
      indopop: ['Lagu Pop Indonesia Terbaru Hits 2026', 'Mahalini Hindia Nadin Tiara Andini Bernadya'],
      rock: ['Lagu Rock Alternatif Indonesia for Revenge Feast Dewa 19 Sheila on 7', 'Indo Rock Hits'],
      chill: ['Lagu Akustik Santai Cafe Indonesia Lofi Chill', 'Fourtwnty Fiersa Besari Danilla Santai'],
      koplo: ['Lagu Dangdut Koplo Terbaru Happy Asmara Denny Caknan Gilga', 'Koplo Jawa Viral'],
      global: ['Top 50 Global Hits Billboard 2026', 'Popular English Songs Today'],
    };

    const queryList = categoryQueries[category] || categoryQueries.all;
    const q = queryList[(page - 1) % queryList.length];
    const searchResults = await ytdl.search(q, { type: 'video', limit: 40 });
    const list = Array.isArray(searchResults) ? searchResults : searchResults?.items || [];
    const items = list.slice(0, 35).map(mapTrackItem);

    res.json({ results: items, category, page, hasMore: true });
  } catch (err) {
    console.error('Error in discover:', err.message);
    res.status(500).json({ error: 'Failed to fetch discover', details: err.message });
  }
});

// Track info
app.get('/api/track/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const info = await ytdl.getInfo(id);
    const details = info.videoDetails;

    const thumbs = details.thumbnails || [];
    const thumbnail =
      thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    res.json({
      id,
      title: details.title || 'Untitled',
      artist: details.author?.name || 'Unknown Artist',
      durationSeconds: parseInt(details.lengthSeconds || '0', 10),
      duration: formatDuration(parseInt(details.lengthSeconds || '0', 10)),
      thumbnail,
      viewCount: details.viewCount ? parseInt(details.viewCount, 10).toLocaleString() : '0',
    });
  } catch (err) {
    console.error(`Error in track ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch track', details: err.message });
  }
});

// Related tracks / Up Next (Adopts YMusic V4 YouTube Radio Mix 'RD<id>' + Title Deduplication)
app.get('/api/related/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const excludeIds = new Set(
      (req.query.exclude ? req.query.exclude.toString().split(',') : []).concat([id])
    );

    let items = [];
    const seenSongNames = new Set();

    // 1. YouTube Radio Mix (RD + videoId) via guestInnertube (unauthenticated, never 400)
    const guest = await getGuestInnertube();
    if (guest) {
      try {
        const next = await guest.actions.execute('/next', {
          playlistId: 'RD' + id,
          videoId: id,
        });

        const panelContents =
          next.data?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents || [];

        for (const entry of panelContents) {
          const v = entry.playlistPanelVideoRenderer;
          if (!v || !v.videoId || excludeIds.has(v.videoId)) continue;

          const rawTitle = v.title?.simpleText || 'Untitled';
          const songKey = normalizeSongName(rawTitle);
          if (songKey && seenSongNames.has(songKey)) continue;
          if (songKey) seenSongNames.add(songKey);

          const thumbs = v.thumbnail?.thumbnails || [];
          const thumbnail =
            thumbs[thumbs.length - 1]?.url ||
            thumbs[0]?.url ||
            `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

          items.push({
            id: v.videoId,
            title: rawTitle,
            artist: v.shortBylineText?.runs?.[0]?.text || 'Unknown Artist',
            duration: v.lengthText?.simpleText || '--:--',
            thumbnail,
          });
        }
      } catch (err) {
        console.warn('Radio Mix (RD) lookup failed:', err.message);
      }
    }

    // 2. If Radio Mix returned fewer than 5 items, fallback to related_videos and deduplicate
    if (items.length < 5) {
      try {
        const info = await ytdl.getInfo(id);
        const related = info.related_videos || [];

        for (const v of related) {
          if (!v.id || excludeIds.has(v.id)) continue;
          const songKey = normalizeSongName(v.title);
          if (songKey && seenSongNames.has(songKey)) continue;
          if (songKey) seenSongNames.add(songKey);

          const thumbs = v.thumbnails || [];
          const thumbnail =
            thumbs[thumbs.length - 1]?.url ||
            thumbs[0]?.url ||
            `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;

          items.push({
            id: v.id,
            title: v.title || 'Untitled',
            artist: v.author?.name || 'Unknown Artist',
            duration: v.duration || formatDuration(v.length_seconds),
            durationSeconds: v.length_seconds || 0,
            thumbnail,
          });
        }
      } catch (e) {
        console.warn('Fallback related lookup failed:', e.message);
      }
    }

    res.json({ results: items.slice(0, 25) });
  } catch (err) {
    console.error(`Error in related for ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch related tracks', details: err.message });
  }
});

// --- AUTHENTICATION (Google Device Code Flow) ---
app.get('/api/auth/status', (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    user: currentUserInfo,
    pending: pendingAuthData,
  });
});

app.post('/api/auth/start', async (req, res) => {
  try {
    const yt = await initInnertube();
    if (!yt) return res.status(500).json({ error: 'Failed to initialize engine' });

    if (isLoggedIn) {
      return res.json({ loggedIn: true, user: currentUserInfo });
    }

    if (pendingAuthData) {
      return res.json({ pending: pendingAuthData });
    }

    // Start OAuth device flow
    await yt.session.oauth.init();
    res.json({ message: 'Device authorization started', pending: pendingAuthData });
  } catch (err) {
    console.error('Auth start error:', err.message);
    res.status(500).json({ error: 'Failed to start authorization', details: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (innertube?.session?.oauth) {
      await innertube.session.oauth.revokeCredentials().catch(() => {});
    }
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
    isLoggedIn = false;
    currentUserInfo = null;
    pendingAuthData = null;
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.status(500).json({ error: 'Logout failed', details: err.message });
  }
});

// User's Personal Playlists (if logged in) via TV Client InnerTube endpoint
app.get('/api/user/playlists', async (req, res) => {
  if (!isLoggedIn || !innertube) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  try {
    const response = await innertube.actions.execute('/browse', {
      browseId: 'FEplaylist_aggregation',
      client: 'TV',
    });

    const items =
      response.data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
        ?.gridRenderer?.items || [];

    const playlists = items
      .map((it) => {
        const t = it.tileRenderer;
        if (!t) return null;
        const id = t.contentId || t.onSelectCommand?.browseEndpoint?.browseId?.replace(/^VL/, '');
        const title = t.metadata?.tileMetadataRenderer?.title?.simpleText || 'Untitled Playlist';
        const thumbs = t.header?.tileHeaderRenderer?.thumbnail?.thumbnails || [];
        const thumbnail = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || '';
        const overlays = t.header?.tileHeaderRenderer?.thumbnailOverlays || [];
        const timeStatus = overlays.find((o) => o.thumbnailOverlayTimeStatusRenderer)
          ?.thumbnailOverlayTimeStatusRenderer;
        const videoCount = timeStatus?.text?.runs?.map((r) => r.text).join('') || '';

        return {
          id,
          title,
          videoCount,
          thumbnail,
        };
      })
      .filter(Boolean);

    res.json({ playlists });
  } catch (err) {
    console.error('Error fetching playlists:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlists', details: err.message });
  }
});

// Get tracks inside a playlist
app.get('/api/playlist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const yt = await initInnertube();
    const browseId = id.startsWith('VL') ? id : 'VL' + id;
    const response = await yt.actions.execute('/browse', {
      browseId,
      client: 'TV',
    });

    const listContents =
      response.data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
        ?.twoColumnRenderer?.rightColumn?.playlistVideoListRenderer?.contents || [];

    const tracks = listContents
      .map((it) => {
        const t = it.tileRenderer;
        if (!t) return null;
        const videoId = t.onSelectCommand?.watchEndpoint?.videoId;
        if (!videoId) return null;
        const title = t.metadata?.tileMetadataRenderer?.title?.simpleText || 'Untitled';
        const artist =
          t.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer
            ?.text?.runs?.[0]?.text || 'Unknown Artist';
        const duration =
          t.header?.tileHeaderRenderer?.thumbnailOverlays?.find(
            (o) => o.thumbnailOverlayTimeStatusRenderer
          )?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '--:--';
        const thumbs = t.header?.tileHeaderRenderer?.thumbnail?.thumbnails || [];
        const thumbnail =
          thumbs[thumbs.length - 1]?.url ||
          thumbs[0]?.url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        return {
          id: videoId,
          title,
          artist,
          duration,
          thumbnail,
        };
      })
      .filter(Boolean);

    res.json({ tracks });
  } catch (err) {
    console.error(`Error fetching playlist ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch playlist songs', details: err.message });
  }
});

// Audio & Video streaming proxy with Range support
app.get('/api/stream/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const isVideo = req.query.type === 'video';
    const quality = req.query.quality || '720p';
    const rangeHeader = req.headers.range;
    const cacheKey = `${id}_${isVideo ? `video_${quality}` : 'audio'}`;

    let format = formatCache.get(cacheKey);
    if (!format || !format.url) {
      const info = await ytdl.getInfo(id);

      if (isVideo) {
        // Video stream by requested quality (e.g. 720p, 1080p, 360p)
        const requestedFormat = info.formats.find(
          (f) => f.hasVideo && f.qualityLabel?.startsWith(quality)
        );
        format =
          requestedFormat ||
          chooseFormat(info.formats, { quality: 'highestvideo' }) ||
          chooseFormat(info.formats, { quality: 'highest' });
      } else {
        // Audio only
        format = chooseFormat(info.formats, {
          filter: { hasAudio: true, hasVideo: false },
          quality: 'highestaudio',
        });
      }

      if (!format || !format.url) {
        return res.status(404).json({ error: 'Media format not found' });
      }

      formatCache.set(cacheKey, format);
      setTimeout(() => formatCache.delete(cacheKey), 30 * 60 * 1000);
    }

    const fetchHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    const upstreamRes = await fetch(format.url, { headers: fetchHeaders });
    res.status(upstreamRes.status);

    const contentType =
      upstreamRes.headers.get('content-type') || format.mimeType || (isVideo ? 'video/mp4' : 'audio/mp4');
    const contentLength = upstreamRes.headers.get('content-length');
    const contentRange = upstreamRes.headers.get('content-range');
    const acceptRanges = upstreamRes.headers.get('accept-ranges') || 'bytes';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', acceptRanges);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (!upstreamRes.body) return res.end();

    const nodeStream = Readable.fromWeb(upstreamRes.body);
    nodeStream.on('error', (err) => {
      console.error('Streaming error during pipe:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => {
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  } catch (err) {
    console.error(`Streaming error for ${req.params.id}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Streaming failed', details: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🎵 YMusic Web Backend running on http://localhost:${PORT}`);
});
