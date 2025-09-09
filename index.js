// VibeCraft backend — OpenAI-guided Apple Music planning + preview + playlist
// Run: node index.js
//
// .env required:
// APPLE_TEAM_ID=XXXXXXXXXX
// APPLE_KEY_ID=XXXXXXXXXX
// APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n(multiline .p8)\n-----END PRIVATE KEY-----"
// OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
// PORT=3001

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const fetch = require("node-fetch"); // npm i node-fetch@2

dotenv.config();

const {
  PORT = 3001,
  APPLE_TEAM_ID,
  APPLE_KEY_ID,
  APPLE_PRIVATE_KEY,
  OPENAI_API_KEY,
} = process.env;

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

// tiny logger
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.url}`);
  if (req.method !== "GET") {
    try { console.log("  body:", JSON.stringify(req.body).slice(0, 800)); } catch {}
  }
  next();
});

app.get("/", (_req, res) => res.send("VibeCraft backend is running ✅"));

// Health check endpoint for deployment testing
app.get("/health", (_req, res) => res.json({ 
  status: "healthy", 
  service: "VibeCraft backend",
  timestamp: new Date().toISOString(),
  version: "1.0.0"
}));

/* ---------------- Apple: developer token ---------------- */
app.get("/apple/devtoken", (_req, res) => {
  try {
    if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
      return res.status(400).json({ error: "Missing Apple creds in .env" });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { iss: APPLE_TEAM_ID, iat: now, exp: now + 60 * 55 },
      APPLE_PRIVATE_KEY,
      { algorithm: "ES256", header: { kid: APPLE_KEY_ID } }
    );
    res.json({ token });
  } catch (err) {
    console.error("Dev token error:", err);
    res.status(500).json({ error: "Failed to sign developer token" });
  }
});

/* =========================================================================
   ENHANCED TWO-PHASE PLAYLIST CREATION:
   Phase 1: OpenAI suggests specific songs with energy mapping
   Phase 2: Search Apple Music, validate availability, create final playlist
   ======================================================================= */
app.post("/mix/plan-search", async (req, res) => {
  try {
    const {
      prompt = "",
      minutes = 60,
      explicit = true,
      storefront = "us",
    } = req.body || {};

    // --- Phase 1: Get AI-suggested specific songs ---
    const plan = await getAIPlan({
      prompt,
      minutes,
      explicit,
    });

    if (!plan.songs || !Array.isArray(plan.songs)) {
      throw new Error("AI failed to generate song suggestions");
    }

    console.log(`AI suggested ${plan.songs.length} songs for "${prompt}"`);

    // --- Phase 2: Search Apple Music for each suggested song ---
    const devToken = signDevToken(10 * 60);
    const finalTracks = [];
    const notFound = [];
    const targetMs = Math.max(10, Number(minutes)) * 60_000;
    let totalMs = 0;

    // Sort songs by their intended position in the playlist
    const sortedSongs = [...plan.songs].sort((a, b) => (a.position || 0) - (b.position || 0));

    for (const suggestedSong of sortedSongs) {
      // Try to find the exact song
      let foundTrack = await findExactSong({
        artist: suggestedSong.artist,
        title: suggestedSong.title,
        storefront,
        explicit,
        developerToken: devToken
      });

      // If exact match not found, try fuzzy search
      if (!foundTrack) {
        foundTrack = await findSimilarSong({
          artist: suggestedSong.artist,
          title: suggestedSong.title,
          storefront,
          explicit,
          developerToken: devToken
        });
      }

      if (foundTrack) {
        // Add energy and position metadata for potential future use
        foundTrack.suggestedEnergy = suggestedSong.energy;
        foundTrack.suggestedPosition = suggestedSong.position;
        foundTrack.rationale = suggestedSong.rationale;
        
        finalTracks.push(foundTrack);
        totalMs += foundTrack.durationMs || 0;
        
        // Stop if we've hit our target duration (with a bit of buffer)
        if (totalMs >= targetMs && finalTracks.length >= 8) break;
        if (finalTracks.length >= 50) break; // reasonable upper limit
      } else {
        notFound.push({
          artist: suggestedSong.artist,
          title: suggestedSong.title,
          energy: suggestedSong.energy
        });
      }
    }

    // If we don't have enough songs and duration, fill with similar tracks
    if (finalTracks.length < 5 || totalMs < targetMs * 0.6) {
      console.log(`Only found ${finalTracks.length} songs, searching for additional tracks...`);
      
      const additionalTracks = await findAdditionalTracks({
        prompt,
        currentTracks: finalTracks,
        targetMs: targetMs - totalMs,
        storefront,
        explicit,
        developerToken: devToken
      });
      
      for (const track of additionalTracks) {
        if (totalMs >= targetMs) break;
        if (finalTracks.length >= 50) break;
        
        finalTracks.push(track);
        totalMs += track.durationMs || 0;
      }
    }

    // Final validation
    if (finalTracks.length === 0) {
      throw new Error("Could not find any songs matching your criteria");
    }

    // --- Return the curated playlist ---
    const ids = finalTracks.map(t => t.id);
    res.json({
      title: plan.title || makeTitleFromPrompt(prompt) || "Custom Mix",
      description: plan.description || (prompt ? `VibeCraft • ${prompt}` : "VibeCraft Mix"),
      tracks: finalTracks.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        durationMs: t.durationMs
      })),
      ids,
      minutesTarget: minutes,
      minutesActual: Math.round(totalMs / 60000),
      aiSuggestedCount: plan.songs.length,
      foundCount: finalTracks.length,
      notFoundCount: notFound.length,
      notFound: notFound.slice(0, 5) // Include a few examples of what wasn't found
    });
  } catch (e) {
    console.error("/mix/plan-search error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ---------------- Create the *same* playlist you previewed ---------------- */
app.post("/apple/create-playlist", async (req, res) => {
  try {
    const {
      developerToken,
      userToken,
      name,
      description,
      ids = [],              // ordered song ids from preview
      storefront = "us",
    } = req.body || {};

    if (!developerToken || !userToken) {
      return res.status(400).json({ error: "Missing developerToken or userToken" });
    }

    const safeName = String(name || "VibeCraft Mix").slice(0, 80);
    const safeDesc = String(description || "Created by VibeCraft").slice(0, 200);

    // (a) Create playlist
    const createUrl = "https://api.music.apple.com/v1/me/library/playlists";
    const mk = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Music-User-Token": userToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attributes: { name: safeName, description: safeDesc } }),
    });
    const mkTxt = await mk.text();
    if (!mk.ok) return res.status(mk.status).send(mkTxt);
    const mkJson = JSON.parse(mkTxt);
    const playlistId = mkJson?.data?.[0]?.id;
    if (!playlistId) return res.status(400).json({ error: "Create failed (no id)" });

    // (b) Add tracks in one go (Apple responds 204 on success)
    let added = 0;
    if (ids.length) {
      const addUrl = `https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks`;
      const add = await fetch(addUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${developerToken}`,
          "Music-User-Token": userToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: ids.map(id => ({ id, type: "songs" })) }),
      });
      if (!add.ok) {
        const addTxt = add.status === 204 ? "" : await add.text();
        return res.status(add.status).send(addTxt || "");
      }
      added = ids.length;
    }

    res.json({ playlistId, added });
  } catch (e) {
    console.error("/apple/create-playlist error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`VibeCraft backend on http://localhost:${PORT}`);
});

/* ====================== helpers ====================== */

function signDevToken(ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: APPLE_TEAM_ID, iat: now, exp: now + ttlSeconds },
    APPLE_PRIVATE_KEY,
    { algorithm: "ES256", header: { kid: APPLE_KEY_ID } }
  );
}

// Call OpenAI to generate specific songs with intelligent energy understanding
async function getAIPlan({ prompt, minutes, explicit }) {
  // If no key, fall back to a simple plan
  if (!OPENAI_API_KEY) {
    const base = (prompt || "playlist").trim();
    return {
      title: makeTitleFromPrompt(base),
      description: `VibeCraft • ${base}`,
      songs: Array.from({ length: Math.min(30, Math.max(8, Math.ceil(minutes / 4))) }, (_, i) => ({
        artist: "Various Artists",
        title: `Track ${i + 1}`,
        energy: 0.5,
        position: i / Math.max(1, Math.ceil(minutes / 4) - 1)
      }))
    };
  }

  const trackCount = Math.min(40, Math.max(8, Math.ceil(minutes / 3.5))); // ~3.5min avg per song
  
  // Determine taste level: hits vs deep cuts
  const tasteLevel = determineTasteLevel(prompt);

  const system = `
You are an expert music curator and DJ with deep knowledge of songs across all genres and eras. Create a specific playlist by suggesting REAL songs that exist.

TASK: Generate ${trackCount} specific songs for a ${minutes}-minute playlist based on the user's description.

USER REQUEST: "${prompt}"

PLAYLIST GUIDELINES:
- Parse the user's description for energy patterns (e.g., "builds up", "winds down", "steady energy", "climax")
- Understand genre, mood, era, and specific artists mentioned
- Order songs to create the described energy journey naturally
- ${tasteLevel.description}

${tasteLevel.guidelines}

ENERGY FLOW EXAMPLES:
- "builds to high energy" → start mellow, gradually increase tempo/intensity
- "winds down at the end" → finish with slower, calmer songs
- "steady party energy" → maintain consistent high-energy throughout
- "chill vibes" → keep relaxed, downtempo throughout
- "climax in the middle" → build up, peak, then come down

Return STRICT JSON:
{
  "title": string,              // creative playlist title reflecting the vibe
  "description": string,        // 1-2 sentences describing the energy journey
  "songs": [
    {
      "artist": string,         // exact artist name as it appears on streaming
      "title": string,          // exact song title
      "energy": number,         // 0.1-0.9 (low to high energy)
      "position": number,       // 0.0-1.0 position in playlist for ordering
      "rationale": string       // brief reason for placement (optional)
    }
  ]
}

CRITICAL REQUIREMENTS:
- Songs must be REAL tracks that exist on streaming platforms
- Order songs to match the described energy pattern from the prompt
- Create smooth transitions between songs
- Include variety while maintaining the requested vibe
- No invented or fake songs
- Pay attention to tempo, genre changes, and energy descriptions

Return only the JSON object, no other text.`.trim();

  const user = `Create a ${minutes}-minute playlist for: "${prompt}". ${explicit ? 'Allow explicit content.' : 'Clean content only.'} Analyze the description for energy patterns and create the playlist accordingly.`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const txt = await r.text();
  if (!r.ok) {
    console.error("OpenAI error:", r.status, txt.slice(0, 300));
    const base = (prompt || "playlist").trim();
    return {
      title: makeTitleFromPrompt(base),
      description: `VibeCraft • ${base}`,
      songs: Array.from({ length: trackCount }, (_, i) => ({
        artist: "Various Artists",
        title: `Track ${i + 1}`,
        energy: 0.5,
        position: i / Math.max(1, trackCount - 1)
      }))
    };
  }
  
  let out = {};
  try {
    const j = JSON.parse(txt);
    const content = j.choices?.[0]?.message?.content || "{}";
    // Clean any markdown formatting if present
    const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
    out = JSON.parse(cleanContent);
  } catch (e) {
    console.warn("Parse AI JSON failed, raw:", txt.slice(0, 200));
    const base = (prompt || "playlist").trim();
    return {
      title: makeTitleFromPrompt(base),
      description: `VibeCraft • ${base}`,
      songs: Array.from({ length: trackCount }, (_, i) => ({
        artist: "Various Artists", 
        title: `Track ${i + 1}`,
        energy: 0.5,
        position: i / Math.max(1, trackCount - 1)
      }))
    };
  }
  
  // Validate and sanitize response
  if (!Array.isArray(out.songs) || !out.songs.length) {
    const base = (prompt || "playlist").trim();
    out.songs = Array.from({ length: trackCount }, (_, i) => ({
      artist: "Various Artists",
      title: `Track ${i + 1}`,
      energy: 0.5,
      position: i / Math.max(1, trackCount - 1)
    }));
  }
  
  // Ensure all songs have required fields
  out.songs = out.songs.map((song, i) => ({
    artist: song.artist || "Unknown Artist",
    title: song.title || `Track ${i + 1}`,
    energy: Math.max(0.1, Math.min(0.9, song.energy || 0.5)),
    position: song.position !== undefined ? song.position : i / Math.max(1, out.songs.length - 1),
    rationale: song.rationale || ""
  }));
  
  return out;
}

// Apple Music: catalog search for songs, returns metadata we need
async function appleSearchSongs({ q, storefront, limit = 25, developerToken }) {
  const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/search`);
  url.searchParams.set("types", "songs");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("term", q);

  const r = await fetch(url, { headers: { Authorization: `Bearer ${developerToken}` } });
  const txt = await r.text();
  if (!r.ok) return [];
  try {
    const j = JSON.parse(txt);
    const items = j?.results?.songs?.data || [];
    return items.map(d => ({
      id: d.id,
      title: d?.attributes?.name,
      artist: d?.attributes?.artistName,
      durationMs: d?.attributes?.durationInMillis || 0,
      contentRating: d?.attributes?.contentRating || "",
    })).filter(x => x.id && x.title && x.artist);
  } catch {
    return [];
  }
}

async function appleChartsSongs({ storefront, limit = 50, developerToken }) {
  const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/charts`);
  url.searchParams.set("types", "songs");
  url.searchParams.set("limit", String(Math.min(limit, 50)));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${developerToken}` } });
  const txt = await r.text();
  if (!r.ok) return [];
  try {
    const j = JSON.parse(txt);
    const arr = j?.results?.songs?.[0]?.data || [];
    return arr.map(d => ({
      id: d.id,
      title: d?.attributes?.name,
      artist: d?.attributes?.artistName,
      durationMs: d?.attributes?.durationInMillis || 0,
      contentRating: d?.attributes?.contentRating || "",
    })).filter(x => x.id && x.title && x.artist);
  } catch {
    return [];
  }
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function makeTitleFromPrompt(p) {
  const t = (p || "").trim();
  if (!t) return "";
  const out = t
    .replace(/["""]/g, "")
    .split(/\s+/)
    .slice(0, 7)
    .map(w => (w[0] ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
  return out.length > 32 ? out.slice(0, 32) + "…" : out;
}


// Determine taste level based on prompt analysis
function determineTasteLevel(prompt) {
  const p = (prompt || "").toLowerCase();
  
  // Keywords that suggest mainstream/hits preference
  const mainstreamKeywords = [
    "hits", "party", "dance", "workout", "90s", "80s", "70s", "60s",
    "classic", "popular", "radio", "chart", "top", "best", "greatest",
    "anthems", "bangers", "crowd", "celebration"
  ];
  
  // Keywords that suggest deeper/underground preference  
  const deepKeywords = [
    "similar to", "like", "influenced by", "reminds me of", "underground",
    "indie", "deep cuts", "b-sides", "rare", "obscure", "hidden gems",
    "artist", "band", "sounds like", "in the style of", "experimental"
  ];
  
  const hasMainstream = mainstreamKeywords.some(kw => p.includes(kw));
  const hasDeep = deepKeywords.some(kw => p.includes(kw));
  
  if (hasDeep && !hasMainstream) {
    return {
      description: "Deep cuts and lesser-known tracks preferred",
      guidelines: [
        "- Prioritize album tracks, B-sides, and lesser-known songs",
        "- Include some popular tracks but focus on artistic depth",
        "- Explore the full catalog of mentioned artists",
        "- Mix well-known artists with similar underground acts",
        "- Aim for 70% deep cuts, 30% popular tracks"
      ].join('\n')
    };
  } else if (hasMainstream && !hasDeep) {
    return {
      description: "Popular hits and crowd-pleasers preferred", 
      guidelines: [
        "- Focus on chart-toppers, radio hits, and widely recognized songs",
        "- Include the biggest songs from each artist/era mentioned",
        "- Prioritize songs people will sing along to",
        "- Use mainstream releases over deep album cuts",
        "- Aim for 80% hits, 20% popular album tracks"
      ].join('\n')
    };
  } else {
    return {
      description: "Balanced mix of popular and interesting tracks",
      guidelines: [
        "- Mix popular hits with quality album tracks",
        "- Include both mainstream and slightly deeper selections",
        "- Balance familiarity with musical discovery",
        "- Represent artists with both hits and fan favorites",
        "- Aim for 50% hits, 50% album tracks and deep cuts"
      ].join('\n')
    };
  }
}

// Enhanced search functions for specific song matching
async function findExactSong({ artist, title, storefront, explicit, developerToken }) {
  // Try exact search first
  const exactQuery = `${title} ${artist}`.trim();
  const results = await appleSearchSongs({ 
    q: exactQuery, 
    storefront, 
    limit: 10, 
    developerToken 
  });
  
  // Look for exact matches (case insensitive)
  const exactMatch = results.find(song => {
    const titleMatch = normalizeString(song.title) === normalizeString(title);
    const artistMatch = normalizeString(song.artist) === normalizeString(artist);
    return titleMatch && artistMatch;
  });
  
  if (exactMatch && (explicit || exactMatch.contentRating !== "explicit")) {
    return exactMatch;
  }
  
  // Try with just the song title if no exact match
  if (title.length > 3) {
    const titleResults = await appleSearchSongs({ 
      q: title, 
      storefront, 
      limit: 10, 
      developerToken 
    });
    
    const titleMatch = titleResults.find(song => {
      const titleSimilar = calculateSimilarity(normalizeString(song.title), normalizeString(title)) > 0.8;
      const artistSimilar = calculateSimilarity(normalizeString(song.artist), normalizeString(artist)) > 0.6;
      return titleSimilar && artistSimilar;
    });
    
    if (titleMatch && (explicit || titleMatch.contentRating !== "explicit")) {
      return titleMatch;
    }
  }
  
  return null;
}

async function findSimilarSong({ artist, title, storefront, explicit, developerToken }) {
  // Try fuzzy searches with different combinations
  const searchQueries = [
    `${artist} ${title}`,
    `${artist}`,
    title.length > 5 ? title : null
  ].filter(Boolean);
  
  for (const query of searchQueries) {
    const results = await appleSearchSongs({ 
      q: query, 
      storefront, 
      limit: 15, 
      developerToken 
    });
    
    // Find the best fuzzy match
    const scored = results.map(song => ({
      ...song,
      score: calculateMatchScore(song, { artist, title })
    })).filter(song => song.score > 0.4);
    
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      const bestMatch = scored[0];
      
      if (explicit || bestMatch.contentRating !== "explicit") {
        return bestMatch;
      }
    }
  }
  
  return null;
}

async function findAdditionalTracks({ prompt, currentTracks, targetMs, storefront, explicit, developerToken }) {
  const additionalTracks = [];
  const currentArtists = new Set(currentTracks.map(t => normalizeString(t.artist)));
  const currentTitles = new Set(currentTracks.map(t => normalizeString(t.title)));
  
  // Generate broader search queries based on what we found
  const searchQueries = generateBackupQueries(prompt, currentTracks);
  
  for (const query of searchQueries) {
    if (additionalTracks.length * 240000 >= targetMs) break; // ~4min per song estimate
    
    const results = await appleSearchSongs({ 
      q: query, 
      storefront, 
      limit: 20, 
      developerToken 
    });
    
    for (const song of results) {
      // Skip if we already have this song or artist
      if (currentTitles.has(normalizeString(song.title))) continue;
      if (currentArtists.has(normalizeString(song.artist)) && Math.random() > 0.3) continue; // Sometimes skip same artist
      
      // Skip explicit if not allowed
      if (!explicit && song.contentRating === "explicit") continue;
      
      additionalTracks.push(song);
      currentArtists.add(normalizeString(song.artist));
      currentTitles.add(normalizeString(song.title));
      
      if (additionalTracks.length >= 20) break; // reasonable limit
    }
  }
  
  return additionalTracks;
}

// Helper functions for string matching and similarity
function normalizeString(str) {
  return (str || "").toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateSimilarity(str1, str2) {
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);
  
  if (s1 === s2) return 1.0;
  
  const words1 = s1.split(" ");
  const words2 = s2.split(" ");
  
  let matches = 0;
  for (const word1 of words1) {
    for (const word2 of words2) {
      if (word1 === word2 || (word1.length > 3 && word2.includes(word1)) || (word2.length > 3 && word1.includes(word2))) {
        matches++;
        break;
      }
    }
  }
  
  return matches / Math.max(words1.length, words2.length);
}

function calculateMatchScore(song, target) {
  const titleScore = calculateSimilarity(song.title, target.title) * 0.6;
  const artistScore = calculateSimilarity(song.artist, target.artist) * 0.4;
  return titleScore + artistScore;
}

function generateBackupQueries(prompt, currentTracks) {
  const queries = [];
  const p = prompt.toLowerCase();
  
  // Extract genres/styles from prompt
  if (p.includes("rock")) queries.push("rock essentials", "classic rock");
  if (p.includes("hip hop") || p.includes("rap")) queries.push("hip hop classics", "rap hits");  
  if (p.includes("electronic") || p.includes("edm")) queries.push("electronic music", "dance hits");
  if (p.includes("pop")) queries.push("pop hits", "pop classics");
  if (p.includes("indie")) queries.push("indie rock", "indie favorites");
  if (p.includes("jazz")) queries.push("jazz classics", "jazz standards");
  if (p.includes("country")) queries.push("country hits", "country classics");
  if (p.includes("reggae")) queries.push("reggae classics", "bob marley");
  
  // Use artists from found tracks to find similar
  const artists = [...new Set(currentTracks.map(t => t.artist))].slice(0, 3);
  for (const artist of artists) {
    queries.push(`similar to ${artist}`, `${artist} radio`);
  }
  
  // Generic fallbacks if nothing else
  if (queries.length === 0) {
    queries.push("popular songs", "hit songs", "chart toppers", "best songs");
  }
  
  return queries.slice(0, 8); // Limit queries
}