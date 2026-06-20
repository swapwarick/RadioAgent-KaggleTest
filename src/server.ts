import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { InMemoryRunner, toStructuredEvents, Gemini } from '@google/adk';
import { worldRadioAgent, CustomGroqLlm, CustomNvidiaNimLlm } from './agent.js';

// Resolve directory paths for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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

  const handleResponse = (proxyRes: http.IncomingMessage, originalUrl: string) => {
    // Follow a single redirect recursively
    if ((proxyRes.statusCode === 301 || proxyRes.statusCode === 302) && proxyRes.headers.location) {
      proxyRes.resume();
      const redirected = new URL(proxyRes.headers.location, originalUrl);
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
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  // Set headers for Server-Sent Events (SSE)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable buffering for Nginx if proxying
  });

  const uId = 'playground-user';
  const sId = sessionId || 'default-session';

  console.log(`[Server] Chat request - Session: ${sId}, Msg: "${message}"`);

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
          parts: [{ text: message }],
        },
      });

      let hitRateLimit = false;

      for await (const rawEvent of eventGenerator) {
        const author = rawEvent.author || 'system';
        const structuredEvents = toStructuredEvents(rawEvent);

        for (const structEv of structuredEvents) {
          if (structEv.type === 'error') {
            const errMsg = structEv.error instanceof Error ? structEv.error.message : String(structEv.error);
            const isRateLimit = errMsg.includes('429') || 
                                errMsg.toLowerCase().includes('rate limit') || 
                                errMsg.toLowerCase().includes('limit reached');

            if (isRateLimit && attemptIndex + 1 < modelAttempts.length) {
              hitRateLimit = true;
              break;
            }
            res.write(`data: ${JSON.stringify({ author, ...structEv, message: errMsg })}\n\n`);
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
