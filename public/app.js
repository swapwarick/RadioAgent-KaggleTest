// Constants and UI Elements
const sessionId = 'session_' + Math.random().toString(36).substring(2, 11);
let activeAgentMessageEl = null;
let currentAgentText = '';
let isGenerating = false;
let audioContext = null;
let audioSource = null;
let analyser = null;
let visualizerAnimationId = null;

// Globe.GL states
let globeInstance = null;
let discoveredStationsData = [];
let currentlyPlayingStation = null;
let countryCoordsMap = {};

// DOM Elements
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendBtn = document.getElementById('send-btn');
const tracePanel = document.getElementById('agent-trace');
const traceToggle = document.getElementById('trace-toggle');
const traceLogs = document.getElementById('trace-logs');
const suggestions = document.querySelectorAll('.chip');
const sessionTag = document.getElementById('session-tag');


// Player Elements
const audioElement = document.getElementById('audio-element');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const muteBtn = document.getElementById('mute-btn');
const volumeIcon = document.getElementById('volume-icon');
const muteIcon = document.getElementById('mute-icon');
const volumeSlider = document.getElementById('volume-slider');
const playbackStatus = document.getElementById('playback-status');
const currentStationName = document.getElementById('current-station-name');
const currentStationGenre = document.getElementById('current-station-genre');
const currentStationLocation = document.getElementById('current-station-location');
const currentStreamInfo = document.getElementById('current-stream-info');
const stationsList = document.getElementById('stations-list');
const stationsCount = document.getElementById('stations-count');
const tunerFrequency = document.getElementById('tuner-frequency');
const visualizerCanvas = document.getElementById('visualizer-canvas');
const canvasCtx = visualizerCanvas.getContext('2d');

// Set Session ID in header
sessionTag.textContent = `Session: ${sessionId.substring(8)}`;

// Resize visualizer canvas
function resizeCanvas() {
  visualizerCanvas.width = visualizerCanvas.parentElement.clientWidth;
  visualizerCanvas.height = 90;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ==========================================
// 2. CHAT & AGENT ORCHESTRATION
// ==========================================

// Collapsible Trace toggle
traceToggle.addEventListener('click', () => {
  tracePanel.classList.toggle('collapsed');
});

// Suggestions Chips submit
suggestions.forEach(chip => {
  chip.addEventListener('click', () => {
    if (isGenerating) return;
    chatInput.value = chip.dataset.query;
    chatForm.dispatchEvent(new Event('submit'));
  });
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = chatInput.value.trim();
  if (!query || isGenerating) return;

  chatInput.value = '';
  appendUserMessage(query);
  startGeneratorState();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: query, sessionId }),
    });

    if (!response.ok) {
      throw new Error(`Server error: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // Hold onto partial line

      for (const line of lines) {
        if (line.trim().startsWith('data: ')) {
          try {
            const data = JSON.parse(line.trim().substring(6));
            handleAgentEvent(data);
          } catch (jsonErr) {
            console.error('Error parsing SSE json:', jsonErr, line);
          }
        }
      }
    }
  } catch (err) {
    console.error('Chat generation failed:', err);
    appendSystemMessage(`Error: ${err.message}`);
    stopGeneratorState();
  }
});

function handleAgentEvent(data) {
  const { author, type, content, call, result, message } = data;

  switch (type) {
    case 'thought':
      appendTraceLog('thought', `[Thought - ${author}] ${content}`);
      break;

    case 'tool_call':
      const argsStr = JSON.stringify(call.args);
      appendTraceLog('tool_call', `[Tool Call] ${author} called "${call.name}" with args: ${argsStr}`);
      break;

    case 'tool_result':
      const resStr = typeof result.response === 'object' ? JSON.stringify(result.response) : result.response;
      appendTraceLog('tool_result', `[Tool Result] "${result.name}" returned: ${resStr}`);
      break;

    case 'content':
      appendAgentDelta(content);
      break;

    case 'error':
      appendTraceLog('error', `[Error] ${message}`);
      appendSystemMessage(`Agent Error: ${message}`);
      break;

    case 'done':
      stopGeneratorState();
      finalizeAgentMessage();
      break;
  }
}

function startGeneratorState() {
  isGenerating = true;
  sendBtn.disabled = true;
  chatInput.disabled = true;
  activeAgentMessageEl = null;
  currentAgentText = '';
  
  // Clear trace logs
  traceLogs.innerHTML = '';
  tracePanel.classList.remove('collapsed');
}

function stopGeneratorState() {
  isGenerating = false;
  sendBtn.disabled = false;
  chatInput.disabled = false;
}

// Message Rendering Helpers
function appendUserMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message user-message';
  msg.innerHTML = `<div class="message-content">${escapeHTML(text)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message system-message';
  msg.innerHTML = `<div class="message-content">${escapeHTML(text)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendAgentDelta(text) {
  if (!activeAgentMessageEl) {
    activeAgentMessageEl = document.createElement('div');
    activeAgentMessageEl.className = 'message agent-message';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    activeAgentMessageEl.appendChild(contentDiv);
    
    chatMessages.appendChild(activeAgentMessageEl);
  }

  currentAgentText += text;
  // Simple markdown-to-html conversion for display
  activeAgentMessageEl.querySelector('.message-content').innerHTML = parseSimpleMarkdown(currentAgentText);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function finalizeAgentMessage() {
  // Extract json-stations block
  const regex = /```json-stations\s*([\s\S]*?)\s*```/;
  const match = currentAgentText.match(regex);
  if (match) {
    try {
      const stations = JSON.parse(match[1].trim());
      updateDiscoveredStations(stations);
    } catch (err) {
      console.error('Failed to parse json-stations from message:', err);
    }
  }
}

function appendTraceLog(type, logText) {
  const empty = traceLogs.querySelector('.trace-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = `trace-log-item ${type}`;
  item.textContent = logText;
  traceLogs.appendChild(item);
  traceLogs.scrollTop = traceLogs.scrollHeight;
}

function updateDiscoveredStations(stations) {
  if (!stations || !Array.isArray(stations) || stations.length === 0) {
    return;
  }

  // Map stations to coordinates
  discoveredStationsData = stations.map(station => {
    const coords = getCoordinatesForLocation(station.location);
    return {
      ...station,
      lat: coords ? coords[0] : 0,
      lng: coords ? coords[1] : 0,
      isPlaying: currentlyPlayingStation && currentlyPlayingStation.url === station.url
    };
  });

  stationsCount.textContent = `${discoveredStationsData.length} Station${discoveredStationsData.length > 1 ? 's' : ''}`;
  stationsList.innerHTML = '';

  discoveredStationsData.forEach(station => {
    const card = document.createElement('div');
    card.className = `station-card-item${station.isPlaying ? ' active-playing' : ''}`;
    card.dataset.url = station.url;

    card.innerHTML = `
      <div class="station-card-info">
        <div class="station-card-name" title="${escapeHTML(station.name)}">${escapeHTML(station.name)}</div>
        <div class="station-card-meta">
          <span class="badge">${escapeHTML(station.genre)}</span>
          <span class="location" title="${escapeHTML(station.location)}">${escapeHTML(station.location)}</span>
        </div>
      </div>
      <div class="station-card-action">
        <button class="tune-in-btn">${station.isPlaying ? 'Playing' : 'Tune In'}</button>
      </div>
    `;

    card.querySelector('.tune-in-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      tuneInStation(station);
    });

    card.addEventListener('click', () => {
      // Orbit camera over this location
      if (globeInstance && (station.lat !== 0 || station.lng !== 0)) {
        globeInstance.pointOfView({ lat: station.lat, lng: station.lng, altitude: 1.8 }, 1200);
      }
    });

    stationsList.appendChild(card);
  });

  // Load points into Globe
  if (globeInstance) {
    globeInstance.pointsData(discoveredStationsData);
  }
}

// Simple Sanitizers
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function parseSimpleMarkdown(md) {
  // Escape raw HTML first
  let html = escapeHTML(md);
  
  // Format code blocks (like json-stations)
  html = html.replace(/```(json-stations|json|javascript|bash|css|html)?\s*([\s\S]*?)\s*```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang || 'txt'}">${code}</code></pre>`;
  });
  
  // Convert lines into paragraphs
  html = html.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  
  // Bold formatting
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  return html;
}

// ==========================================
// 3. AUDIO TUNING & PLAYBACK CONTROLS
// ==========================================

function tuneInStation(station) {
  currentlyPlayingStation = station;

  // Update UI frequency randomly for realistic tuning feel
  const randFreq = (Math.random() * (107.9 - 87.5) + 87.5).toFixed(1);
  tunerFrequency.textContent = `${randFreq} MHz`;

  // Update Details Card
  currentStationName.textContent = station.name;
  currentStationGenre.textContent = station.genre;
  currentStationLocation.textContent = station.location;
  currentStreamInfo.textContent = `Format: ${station.contentType || 'unknown'} | URL: ${station.url.substring(0, 45)}...`;

  playbackStatus.textContent = 'Connecting...';
  playPauseBtn.disabled = false;

  // Route through local proxy to bypass CORS and mixed-content restrictions
  const proxyUrl = `/api/stream?url=${encodeURIComponent(station.url)}`;
  audioElement.src = proxyUrl;
  audioElement.load();

  // Try to play
  audioElement.play()
    .then(() => {
      playbackStatus.textContent = 'Playing';
      showPauseIcon();
      setupAudioContext(); // Setup Web Audio API visualizer
      updateGlobePlayState(true);
    })
    .catch(err => {
      console.warn('Playback failed, streaming might be blocked or unreachable:', err);
      playbackStatus.textContent = 'Stream error / Offline';
      showPlayIcon();
      updateGlobePlayState(false);
    });

  // Animate flight to coordinate on the globe
  if (globeInstance) {
    const coords = getCoordinatesForLocation(station.location);
    const lat = coords ? coords[0] : (station.lat || 0);
    const lng = coords ? coords[1] : (station.lng || 0);
    if (lat !== 0 || lng !== 0) {
      globeInstance.pointOfView({ lat, lng, altitude: 1.8 }, 1500);
    }
  }
}

// Play/Pause button handler
playPauseBtn.addEventListener('click', () => {
  if (audioElement.paused) {
    audioElement.play()
      .then(() => {
        playbackStatus.textContent = 'Playing';
        showPauseIcon();
        setupAudioContext();
        updateGlobePlayState(true);
      })
      .catch(err => {
        playbackStatus.textContent = 'Playback Error';
        console.error(err);
        updateGlobePlayState(false);
      });
  } else {
    audioElement.pause();
    playbackStatus.textContent = 'Paused';
    showPlayIcon();
    updateGlobePlayState(false);
  }
});

// Audio element state changes
audioElement.addEventListener('waiting', () => {
  playbackStatus.textContent = 'Buffering...';
});
audioElement.addEventListener('playing', () => {
  playbackStatus.textContent = 'Playing';
  showPauseIcon();
  updateGlobePlayState(true);
});
audioElement.addEventListener('pause', () => {
  playbackStatus.textContent = 'Paused';
  showPlayIcon();
  updateGlobePlayState(false);
});
audioElement.addEventListener('error', (e) => {
  playbackStatus.textContent = 'Playback Error / Dead link';
  showPlayIcon();
  updateGlobePlayState(false);
  console.error('Audio tag error event:', e);
});

// Volume Control
volumeSlider.addEventListener('input', (e) => {
  const vol = e.target.value / 100;
  audioElement.volume = vol;
  audioElement.muted = (vol === 0);
  updateVolumeIcons(audioElement.muted);
});

muteBtn.addEventListener('click', () => {
  audioElement.muted = !audioElement.muted;
  updateVolumeIcons(audioElement.muted);
  if (audioElement.muted) {
    volumeSlider.value = 0;
  } else {
    volumeSlider.value = Math.round(audioElement.volume * 100);
  }
});

function updateVolumeIcons(isMuted) {
  if (isMuted) {
    volumeIcon.style.display = 'none';
    muteIcon.style.display = 'block';
  } else {
    volumeIcon.style.display = 'block';
    muteIcon.style.display = 'none';
  }
}

function showPlayIcon() {
  playIcon.style.display = 'block';
  pauseIcon.style.display = 'none';
}

function showPauseIcon() {
  playIcon.style.display = 'none';
  pauseIcon.style.display = 'block';
}

// ==========================================
// 4. CANVAS WAVEFORM VISUALIZER
// ==========================================

function setupAudioContext() {
  if (audioContext) return; // Already setup

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    // Connect source. Note: CORS restrictions apply to createMediaElementSource
    // If stream server doesn't allow CORS, browser blocks Web Audio processing.
    // In that case, we fall back to simulated wave visualizer.
    audioSource = audioContext.createMediaElementSource(audioElement);
    audioSource.connect(analyser);
    analyser.connect(audioContext.destination);

    console.log('[Audio Visualizer] Web Audio API context connected.');
  } catch (err) {
    console.warn('[Audio Visualizer] Failed to connect Web Audio API source due to CORS/Permissions. Falling back to simulation.');
  }
}

// Dynamic Glowing Wave visualizer loop
let wavePhase = 0;
function drawVisualizer() {
  visualizerAnimationId = requestAnimationFrame(drawVisualizer);

  const width = visualizerCanvas.width;
  const height = visualizerCanvas.height;

  canvasCtx.clearRect(0, 0, width, height);

  // Background Grid representation
  canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  canvasCtx.lineWidth = 1;
  for (let i = 20; i < width; i += 40) {
    canvasCtx.beginPath();
    canvasCtx.moveTo(i, 0);
    canvasCtx.lineTo(i, height);
    canvasCtx.stroke();
  }
  for (let i = 15; i < height; i += 30) {
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, i);
    canvasCtx.lineTo(width, i);
    canvasCtx.stroke();
  }

  const isPlaying = !audioElement.paused && !audioElement.muted && audioElement.readyState >= 2;

  // Let's read actual frequency data if connected and CORS is ok
  let dataArray = null;
  if (analyser && isPlaying) {
    try {
      const bufferLength = analyser.frequencyBinCount;
      dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);
    } catch (e) {
      dataArray = null; // Fallback to simulation
    }
  }

  // Draw 3 layers of smooth sine waves (simulating audio signals)
  const drawWave = (amplitudeFactor, frequency, speed, colorHex, lineWidth) => {
    canvasCtx.strokeStyle = colorHex;
    canvasCtx.lineWidth = lineWidth;
    canvasCtx.beginPath();

    wavePhase += speed;

    const sliceWidth = width / 100;
    let x = 0;

    for (let i = 0; i <= 100; i++) {
      // Base wave amplitude based on playing state and frequency data
      let amp = 3; 
      if (isPlaying) {
        if (dataArray) {
          // Map frequency data index to position
          const dataIndex = Math.floor((i / 100) * dataArray.length);
          amp = 5 + (dataArray[dataIndex] || 0) * 0.18 * amplitudeFactor;
        } else {
          // Simulation volume oscillation
          amp = 10 + (Math.sin(wavePhase * 0.5) + 1.5) * 8 * amplitudeFactor;
        }
      }

      // Sine wave equation with boundary fading
      const fade = Math.sin((i / 100) * Math.PI); // Fades out at edges
      const y = height / 2 + Math.sin(i * frequency + wavePhase) * amp * fade;

      if (i === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    canvasCtx.stroke();
  };

  // Render multi-layered glowing waves
  if (isPlaying) {
    // Neon Purple
    drawWave(1.0, 0.15, 0.08, 'rgba(191, 90, 242, 0.8)', 2.5);
    // Neon Cyan
    drawWave(0.8, 0.22, -0.05, 'rgba(90, 200, 250, 0.6)', 1.5);
    // Dark violet background wave
    drawWave(0.4, 0.08, 0.02, 'rgba(10, 132, 255, 0.3)', 4);
  } else {
    // Flat line with tiny noise
    drawWave(0.1, 0.05, 0.005, 'rgba(94, 107, 125, 0.3)', 1);
  }
}

// Start Visualizer
drawVisualizer();

// ==========================================
// 5. COORDINATE GEOCODING & GLOBE MANAGEMENT
// ==========================================

const fallbackCountryCoords = {
  "india": [20.5937, 78.9629],
  "united states": [37.0902, -95.7129],
  "united kingdom": [55.3781, -3.4360],
  "france": [46.2276, 2.2137],
  "germany": [51.1657, 10.4515],
  "canada": [56.1304, -106.3468],
  "australia": [-25.2744, 133.7751],
  "brazil": [-14.2350, -51.9253],
  "russia": [61.5240, 105.3188],
  "china": [35.8617, 104.1954],
  "japan": [36.2048, 138.2529],
  "spain": [40.4637, -3.7492],
  "italy": [41.8719, 12.5674],
  "netherlands": [52.1326, 5.2913],
  "switzerland": [46.8182, 8.2275],
  "sweden": [60.1282, 18.6435],
  "norway": [60.4720, 8.4689],
  "finland": [61.9241, 25.7482],
  "south africa": [-30.5595, 22.9375],
  "new zealand": [-40.9006, 174.8860],
  "mexico": [23.6345, -102.5528],
  "argentina": [-38.4161, -63.6167],
  "chile": [-35.6751, -71.5430],
  "colombia": [4.5709, -72.9301],
  "austria": [47.5162, 14.5501],
  "belgium": [50.5039, 4.4699],
  "poland": [51.9194, 19.1451],
  "greece": [39.0742, 21.8243],
  "turkey": [38.9637, 35.2433],
  "egypt": [26.8206, 30.8025],
  "singapore": [1.3521, 103.8198],
  "thailand": [15.8700, 100.9925],
  "vietnam": [14.0583, 108.2772],
  "indonesia": [-0.7893, 113.9213],
  "malaysia": [4.2105, 101.9758],
  "philippines": [12.8797, 121.7740],
  "south korea": [35.9078, 127.7669],
  "ireland": [53.4129, -8.2439],
  "portugal": [39.3999, -8.2245],
  "denmark": [56.2639, 9.5018],
};

// Asynchronously load and cache standard coordinates from REST Countries API
async function loadCountryCoords() {
  const cached = localStorage.getItem('world_radio_country_coords');
  if (cached) {
    try {
      countryCoordsMap = JSON.parse(cached);
      console.log('[Geocoder] Country coordinates loaded from local cache.');
      return;
    } catch (e) {
      console.error('[Geocoder] Failed to parse cached coordinates:', e);
    }
  }

  // Initialize with fallback coords
  countryCoordsMap = { ...fallbackCountryCoords };

  try {
    const res = await fetch('https://restcountries.com/v3.1/all');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) {
      const freshMap = { ...fallbackCountryCoords };
      data.forEach(country => {
        const name = country.name?.common?.toLowerCase();
        const official = country.name?.official?.toLowerCase();
        const latlng = country.latlng;
        if (name && latlng && latlng.length === 2) {
          freshMap[name] = latlng;
        }
        if (official && latlng && latlng.length === 2) {
          freshMap[official] = latlng;
        }
      });
      countryCoordsMap = freshMap;
      localStorage.setItem('world_radio_country_coords', JSON.stringify(freshMap));
      console.log('[Geocoder] Coordinates mapping cache updated from REST Countries API.');
    }
  } catch (err) {
    console.warn('[Geocoder] Live coordinates fetch failed (falling back to offline coordinates map):', err.message);
  }
}

// Convert Location Name string into [latitude, longitude] coordinates
function getCoordinatesForLocation(location) {
  if (!location || typeof location !== 'string') return null;
  const parts = location.split(',').map(p => p.trim().toLowerCase());

  // Check direct names
  for (const part of parts) {
    if (countryCoordsMap[part]) {
      return countryCoordsMap[part];
    }
  }

  // Handle typical naming variations
  for (const part of parts) {
    if (part.includes('usa') || part.includes('united states') || part.includes('us')) {
      return countryCoordsMap['united states'];
    }
    if (part.includes('uk') || part.includes('united kingdom') || part.includes('england')) {
      return countryCoordsMap['united kingdom'];
    }
    if (part.includes('russia')) {
      return countryCoordsMap['russia'];
    }
    if (part.includes('korea')) {
      return countryCoordsMap['south korea'];
    }
  }

  // Try substring checks
  for (const part of parts) {
    for (const countryName of Object.keys(countryCoordsMap)) {
      if (part.includes(countryName) || countryName.includes(part)) {
        return countryCoordsMap[countryName];
      }
    }
  }

  // Fallback: Create deterministic coord spread based on name hash (prevents overlaps on 0,0)
  let hash = 0;
  for (let i = 0; i < location.length; i++) {
    hash = location.charCodeAt(i) + ((hash << 5) - hash);
  }
  const lat = ((hash % 75) + 10) / 2; // Spread latitude between 5°N and 42.5°N
  const lng = ((hash % 170) + 10) / 2; // Spread longitude between 5°E and 90°E
  return [lat, lng];
}

// Initialize Globe.GL inside container
function initGlobe() {
  const container = document.getElementById('globe-container');
  if (!container) return;

  globeInstance = Globe()(container)
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .backgroundColor('rgba(0, 0, 0, 0)') // transparent body blend
    .width(window.innerWidth)
    .height(window.innerHeight)
    .pointColor(d => d.isPlaying ? '#5ac8fa' : '#bf5af2')
    .pointRadius(d => d.isPlaying ? 0.35 : 0.18)
    .pointAltitude(d => d.isPlaying ? 0.12 : 0.06)
    .pointLabel(d => `
      <div style="background: rgba(10, 12, 16, 0.95); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 8px 12px; color: #f5f6f8; font-family: Inter, sans-serif; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5); pointer-events: none;">
        <b style="color: ${d.isPlaying ? '#5ac8fa' : '#bf5af2'}; font-size: 14px;">${escapeHTML(d.name)}</b><br/>
        <span style="font-size: 11px; color: #9aa5b5;">${escapeHTML(d.genre)} · ${escapeHTML(d.location)}</span>
      </div>
    `)
    .onPointClick(d => {
      tuneInStation(d);
    })
    .ringColor(() => '#5ac8fa')
    .ringMaxRadius(4)
    .ringPropagationSpeed(1.5)
    .ringRepeatPeriod(1000);

  // Configure auto rotation (Three.js OrbitControls)
  const controls = globeInstance.controls();
  if (controls) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
  }

  // Handle window resizing
  window.addEventListener('resize', () => {
    if (globeInstance) {
      globeInstance.width(window.innerWidth);
      globeInstance.height(window.innerHeight);
    }
  });
}

// Sync UI and Globe points visual properties with the current playing status
function updateGlobePlayState(isPlaying) {
  discoveredStationsData.forEach(s => {
    s.isPlaying = isPlaying && currentlyPlayingStation && s.url === currentlyPlayingStation.url;
  });

  // Update card items active visual borders
  const cards = document.querySelectorAll('.station-card-item');
  cards.forEach(card => {
    const isThisPlaying = isPlaying && currentlyPlayingStation && card.dataset.url === currentlyPlayingStation.url;
    if (isThisPlaying) {
      card.classList.add('active-playing');
      card.querySelector('.tune-in-btn').textContent = 'Playing';
      
      // Auto-scroll card into view smoothly
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } else {
      card.classList.remove('active-playing');
      card.querySelector('.tune-in-btn').textContent = 'Tune In';
    }
  });

  // Re-render globe elements and rings
  if (globeInstance) {
    globeInstance.pointsData(discoveredStationsData);

    if (isPlaying && currentlyPlayingStation) {
      const coords = getCoordinatesForLocation(currentlyPlayingStation.location);
      const lat = coords ? coords[0] : (currentlyPlayingStation.lat || 0);
      const lng = coords ? coords[1] : (currentlyPlayingStation.lng || 0);
      if (lat !== 0 || lng !== 0) {
        globeInstance.ringsData([{ lat, lng }]);
      }
    } else {
      globeInstance.ringsData([]);
    }
  }
}

// Load Coordinates and Start Globe
loadCountryCoords().then(() => {
  initGlobe();
});


