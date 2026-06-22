import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { InMemoryRunner, toStructuredEvents, Gemini, type Event } from '@google/adk';
import { worldRadioAgent, CustomGroqLlm, CustomNvidiaNimLlm } from './agent.js';

// Resolve directory paths for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: '16kb' })); // cap body size
app.use(express.static(path.join(__dirname, '../public')));

// ==========================================
// RATE LIMITER — /api/chat
// 30 requests per minute per IP
// ==========================================
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute window
  max: 30,                       // max 30 requests per IP
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment before sending another message.' },
  keyGenerator: (req: express.Request) => ipKeyGenerator(req.ip ?? ''), // handles IPv4/IPv6 correctly
});

// ==========================================
// TOPIC GUARD — Radio-only query classifier
// Rejects off-topic messages before they
// reach the LLM, saving API credits.
// ==========================================
const RADIO_KEYWORDS = [
  // Core radio/music
  'radio', 'station', 'stream', 'music', 'listen', 'tune', 'play', 'channel',
  'song', 'track', 'album', 'artist', 'band', 'fm', 'am', 'broadcast',
  // Genres
  'jazz', 'rock', 'pop', 'hip hop', 'hiphop', 'hip-hop', 'classical', 'country',
  'electronic', 'edm', 'techno', 'house', 'ambient', 'chill', 'lofi', 'lo-fi',
  'reggae', 'metal', 'punk', 'folk', 'blues', 'soul', 'r&b', 'rnb', 'kpop',
  'k-pop', 'jpop', 'j-pop', 'bollywood', 'hindi', 'latin', 'salsa', 'indie',
  'alternative', 'dance', 'news', 'talk', 'sports', 'comedy',
  // Locations (common radio searches)
  'india', 'usa', 'uk', 'france', 'germany', 'japan', 'korea', 'brazil',
  'paris', 'london', 'berlin', 'tokyo', 'new york', 'mumbai',
  // Action words
  'find', 'search', 'discover', 'recommend', 'suggest', 'show', 'get',
  'what', 'which', 'where', 'how',
];

function isRadioQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return RADIO_KEYWORDS.some(kw => lower.includes(kw));
}

// Initialize ADK Runner with the root agent
const runner = new InMemoryRunner({
  agent: worldRadioAgent,
  appName: 'WorldRadioFinder',
});

// GET /api/health - Server health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    groqConfigured: !!process.env.GROQ_API_KEY,
    nvidiaConfigured: !!process.env.NVIDIA_API_KEY,
    geminiConfigured: !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_GENAI_API_KEY
  });
});

// GET /api/countries - Proxy for REST Countries API to solve CORS issues
app.get('/api/countries', async (req, res) => {
  try {
    const response = await fetch('https://raw.githubusercontent.com/mledoze/countries/master/dist/countries.json', {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (err: any) {
    console.warn('[Server] Failed to fetch countries from CDN dataset:', err.message);
    res.status(502).json({ error: 'Failed to fetch countries data' });
  }
});

// GET /api/stream - Audio stream proxy (solves CORS + mixed-content for radio streams)
// Usage: /api/stream?url=https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3
// Helper to rewrite relative paths inside .m3u8 files to route through our proxy
function rewritePlaylist(bodyText: string, targetUrl: string): string {
  const lines = bodyText.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }
    try {
      const absoluteUrl = new URL(trimmed, targetUrl).href;
      // Determine proxy route based on file type
      const endpoint = absoluteUrl.includes('.m3u8') ? '/api/stream.m3u8' : '/api/stream';
      return `${endpoint}?url=${encodeURIComponent(absoluteUrl)}`;
    } catch {
      return line;
    }
  });
  return rewritten.join('\n');
}

// GET /api/stream - Audio stream proxy (solves CORS + mixed-content for radio streams)
// Usage: /api/stream?url=https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3
app.get(['/api/stream', '/api/stream.m3u8'], (req, res) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    return res.status(400).send('Missing ?url= parameter');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // SSRF protection: enforce protocol allowlist
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).send('Invalid protocol — only http and https are allowed');
  }
  // SSRF: block all private/internal/loopback ranges and non-http(s) protocols.
  // Covers: localhost, 127.x, 0.0.0.0, RFC-1918 (10.x, 172.16-31.x, 192.168.x),
  //         link-local / AWS metadata (169.254.x), and IPv6 loopback/link-local.
  const PRIVATE_IP = /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|\[|::1$|::$|fd[0-9a-f]{2}:)/i;
  if (PRIVATE_IP.test(parsedUrl.hostname)) {
    return res.status(403).send('Forbidden: Private or internal URLs are not allowed');
  }

  const lib = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WorldRadioFinder/1.0)',
      'Icy-MetaData': '0',
    },
  };

  let redirectCount = 0;
  const handleResponse = (proxyRes: http.IncomingMessage, originalUrl: string) => {
    // Follow redirects (max 3 hops to prevent redirect loops)
    if ((proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 307 || proxyRes.statusCode === 308) && proxyRes.headers.location) {
      if (redirectCount >= 3) {
        proxyRes.resume();
        if (!res.headersSent) res.status(502).send('Too many redirects');
        return;
      }
      redirectCount++;
      proxyRes.resume();
      let redirected: URL;
      try {
        redirected = new URL(proxyRes.headers.location, originalUrl);
      } catch {
        if (!res.headersSent) res.status(502).send('Invalid redirect URL');
        return;
      }
      // Re-check SSRF on redirect target
      const PRIVATE_IP2 = /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|\[|::1$)/;
      if (PRIVATE_IP2.test(redirected.hostname) || !['http:', 'https:'].includes(redirected.protocol)) {
        if (!res.headersSent) res.status(403).send('Forbidden: Redirect to private URL blocked');
        return;
      }
      const lib2 = redirected.protocol === 'https:' ? https : http;
      const req2 = lib2.get(redirected.href, { headers: options.headers }, (res2) => {
        handleResponse(res2, redirected.href);
      });
      req2.on('error', () => {
        if (!res.headersSent) res.status(502).send('Stream redirect failed');
      });
      return;
    }

    const contentType = proxyRes.headers['content-type'] || '';
    res.setHeader('Content-Type', contentType || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode || 200);

    const isM3u8 = originalUrl.toLowerCase().includes('.m3u8') || 
                   contentType.toLowerCase().includes('mpegurl') || 
                   contentType.toLowerCase().includes('m3u8');

    if (isM3u8) {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewritePlaylist(bodyText, originalUrl);
        res.setHeader('Content-Length', Buffer.byteLength(rewritten));
        res.end(rewritten);
      });
    } else {
      proxyRes.pipe(res);
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    handleResponse(proxyRes, targetUrl);
  });

  proxyReq.on('error', (err) => {
    console.error('[Stream Proxy] Error:', err.message);
    if (!res.headersSent) res.status(502).send('Stream unavailable');
  });

  // Clean up when client disconnects
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

// POST /api/chat - SSE Stream Chat Endpoint
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, sessionId } = req.body;

  // ── Input Sanitization ─────────────────────────────────────────────────────
  // 1. Type + presence check
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  // 2. Hard length cap (before any processing — guards against memory pressure)
  if (message.length > 4000) {
    return res.status(400).json({ error: 'Message too long. Maximum 4000 characters allowed.' });
  }

  // 3. Strip null bytes and non-printable C0/C1 control characters that could
  //    poison server logs, confuse LLM tokenizers, or bypass topic filtering.
  //    Preserves: printable ASCII, Unicode letters/emoji, tab (\t), newline (\n), CR (\r)
  let sanitizedMessage = message
    .replace(/\x00/g, '')                                  // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')    // C0 control chars (keep \t \n \r)
    .replace(/[\x80-\x9F]/g, '');                          // C1 control chars

  // 4. Collapse excessive whitespace runs (prevents padding/stuffing attacks)
  //    e.g. 500 spaces + "jazz" → "jazz"
  sanitizedMessage = sanitizedMessage
    .replace(/[ \t]{50,}/g, ' ')     // collapse long horizontal whitespace runs
    .replace(/\n{5,}/g, '\n\n')      // cap consecutive newlines at 2
    .trim();

  // 5. Minimum length after sanitization (reject blank/whitespace-only inputs)
  if (sanitizedMessage.length < 2) {
    return res.status(400).json({ error: 'Message is too short or empty after sanitization.' });
  }

  // 6. Sanitize sessionId — allow only safe alphanumeric/dash/underscore chars,
  //    cap at 64 chars. Falls back to 'default-session' if invalid/missing.
  const rawSessionId = typeof sessionId === 'string' ? sessionId : '';
  const sanitizedSessionId = /^[a-zA-Z0-9_-]{1,64}$/.test(rawSessionId)
    ? rawSessionId
    : 'default-session';

  // ── Topic Guard ────────────────────────────────────────────────────────────
  // Reject off-topic queries before they consume any LLM API credits.
  if (!isRadioQuery(sanitizedMessage)) {
    console.log(`[Topic Guard] Rejected off-topic query: "${sanitizedMessage.substring(0, 80)}"`);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const refusalMsg = [
      "I'm the **World Radio Finder & Tuner** 📻 — I can only help you discover and stream internet radio stations.",
      "",
      "Try asking me something like:",
      "- *\"Find jazz stations from Paris\"*",
      "- *\"Play classic rock USA\"*",
      "- *\"Hindi Bollywood radio\"*",
      "- *\"K-Pop stations from Korea\"*",
    ].join('\n');
    res.write(`data: ${JSON.stringify({ type: 'content', author: 'world_radio_finding_agent', content: refusalMsg })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }

  // Set headers for Server-Sent Events (SSE)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable buffering for Nginx if proxying
  });

  const uId = 'playground-user';
  const sId = sanitizedSessionId;

  console.log(`[Server] Chat request - Session: ${sId}, Msg: "${sanitizedMessage.substring(0, 120)}"`);

  try {
    // Check key requirements before calling the LLM
    const groqKey = process.env.GROQ_API_KEY;
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

    // Define the sequence of models to try
    const modelAttempts: any[] = [];
    if (groqKey) {
      modelAttempts.push({
        name: 'Groq (llama-3.3-70b-versatile)',
        setup: () => new CustomGroqLlm({ model: 'llama-3.3-70b-versatile', apiKey: groqKey }),
      });
    }
    if (nvidiaKey) {
      modelAttempts.push({
        name: 'NVIDIA NIM (meta/llama-3.3-70b-instruct)',
        setup: () => new CustomNvidiaNimLlm({ model: 'meta/llama-3.3-70b-instruct', apiKey: nvidiaKey }),
      });
    }
    if (geminiKey) {
      modelAttempts.push({
        name: 'Gemini (gemini-2.5-flash)',
        setup: () => new Gemini({ model: 'gemini-2.5-flash', apiKey: geminiKey }),
      });
    }

    if (modelAttempts.length === 0) {
      // Stream an error to the frontend
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: 'No LLM API key (GROQ_API_KEY, NVIDIA_API_KEY, or GEMINI_API_KEY) is configured. Please configure keys in your .env file or playground settings.',
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // Ensure the session is created in the memory service before running
    await runner.sessionService.getOrCreateSession({
      appName: 'WorldRadioFinder',
      userId: uId,
      sessionId: sId,
    });

    let attemptIndex = 0;

    const runSession = async () => {
      const currentAttempt = modelAttempts[attemptIndex];
      worldRadioAgent.model = currentAttempt.setup();

      const eventGenerator = runner.runAsync({
        userId: uId,
        sessionId: sId,
        newMessage: {
          role: 'user',
          parts: [{ text: sanitizedMessage }],
        },
      });

      let hitRateLimit = false;

      for await (const rawEvent of eventGenerator) {
        const author = rawEvent.author || 'system';
        const structuredEvents = toStructuredEvents(rawEvent as Event);

        for (const structEv of structuredEvents) {
          if (structEv.type === 'error') {
            // In ADK 1.x, structEv.error is an Error object
            const errMsg = structEv.error instanceof Error ? structEv.error.message : String(structEv.error);
            const isRateLimit = errMsg.includes('429') || 
                                errMsg.toLowerCase().includes('rate limit') || 
                                errMsg.toLowerCase().includes('limit reached');

            if (isRateLimit && attemptIndex + 1 < modelAttempts.length) {
              hitRateLimit = true;
              break;
            }
            // Send error to frontend in the expected shape
            res.write(`data: ${JSON.stringify({ author, type: 'error', message: errMsg })}\n\n`);
          } else if (structEv.type === 'finished') {
            // ADK 1.x emits a 'finished' event at the end — we treat it as a no-op here
            // because we send our own 'done' event after the loop
          } else {
            res.write(`data: ${JSON.stringify({ author, ...structEv })}\n\n`);
          }
        }
        if (hitRateLimit) break;
      }

      if (hitRateLimit) {
        attemptIndex++;
        const nextAttempt = modelAttempts[attemptIndex];
        console.log(`[Server] ${currentAttempt.name} rate limit hit. Falling back to ${nextAttempt.name}.`);
        res.write(`data: ${JSON.stringify({
          type: 'thought',
          content: `${currentAttempt.name} rate limit reached. Automatically switching models to ${nextAttempt.name} and retrying query...`,
        })}\n\n`);

        // Retry the session with the next model
        await runSession();
      }
    };

    await runSession();

    // Indicate completion
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err: any) {
    console.error('[Server Error]', err);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: err.message || 'An error occurred during agent execution.',
    })}\n\n`);
  } finally {
    res.end();
  }
});

// Fallback: serve index.html for all other routes
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`World Radio Finding Agent Playground is Live!`);
  console.log(`Access local console: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
