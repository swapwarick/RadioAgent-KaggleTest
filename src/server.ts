import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { InMemoryRunner, toStructuredEvents, Gemini } from '@google/adk';
import { worldRadioAgent, CustomGroqLlm } from './agent.js';

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
  res.json({ status: 'ok', groqConfigured: !!process.env.GROQ_API_KEY });
});

// GET /api/stream - Audio stream proxy (solves CORS + mixed-content for radio streams)
// Usage: /api/stream?url=https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3
app.get('/api/stream', (req, res) => {
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

  const proxyReq = lib.request(options, (proxyRes) => {
    // Follow a single redirect
    if ((proxyRes.statusCode === 301 || proxyRes.statusCode === 302) && proxyRes.headers.location) {
      proxyRes.resume();
      const redirected = new URL(proxyRes.headers.location, targetUrl);
      const lib2 = redirected.protocol === 'https:' ? https : http;
      const req2 = lib2.get(redirected.href, { headers: options.headers }, (res2) => {
        res.setHeader('Content-Type', res2.headers['content-type'] || 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res2.pipe(res);
      });
      req2.on('error', () => res.status(502).send('Stream redirect failed'));
      return;
    }

    res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(proxyRes.statusCode || 200);
    proxyRes.pipe(res);
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
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

    if (groqKey) {
      // Dynamically update the agent's model to use the latest Groq API key
      worldRadioAgent.model = new CustomGroqLlm({
        model: 'llama-3.3-70b-versatile',
        apiKey: groqKey,
      });
    } else if (geminiKey) {
      // Dynamically update the agent's model to use the latest Gemini API key
      worldRadioAgent.model = new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: geminiKey,
      });
    } else {
      // Stream an error to the frontend
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: 'No LLM API key (GROQ_API_KEY or GEMINI_API_KEY) is configured. Please configure keys in your .env file or playground settings.',
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

    const runSession = async (useGeminiFallback: boolean) => {
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
            if (useGeminiFallback && geminiKey && (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('limit reached'))) {
              hitRateLimit = true;
              break;
            }
            res.write(`data: ${JSON.stringify({ author, ...structEv })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ author, ...structEv })}\n\n`);
          }
        }
        if (hitRateLimit) break;
      }

      if (hitRateLimit) {
        console.log('[Server] Groq rate limit hit. Falling back to Gemini.');
        res.write(`data: ${JSON.stringify({
          type: 'thought',
          content: 'Groq API rate limit reached (429). Automatically switching models to Gemini (gemini-2.5-flash) and retrying query...',
        })}\n\n`);

        // Re-assign the agent model to Gemini
        worldRadioAgent.model = new Gemini({
          model: 'gemini-2.5-flash',
          apiKey: geminiKey!,
        });

        // Retry the session once with fallback disabled
        await runSession(false);
      }
    };

    await runSession(true);

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
