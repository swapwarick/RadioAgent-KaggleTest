// Constants and UI Elements
const sessionId = 'session_mob_' + Math.random().toString(36).substring(2, 11);
let activeAgentMessageEl = null;
let currentAgentText = '';
let isGenerating = false;
let audioContext = null;
let audioSource = null;
let analyser = null;
let visualizerAnimationId = null;
let hlsInstance = null;

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

// Pointer-events styling adjustments dynamically for container layout clicks
const mobileAppContainer = document.querySelector('.mobile-app-container');
const mobileViews = document.querySelector('.mobile-views');
const viewChat = document.getElementById('view-chat');
const viewGlobe = document.getElementById('view-globe');
const viewTuner = document.getElementById('view-tuner');
const globeContainerMobile = document.getElementById('globe-container-mobile');

mobileAppContainer.style.pointerEvents = 'none';
mobileViews.style.pointerEvents = 'none';

// Re-enable pointer events for interactive sub-sections
document.querySelector('.mobile-header').style.pointerEvents = 'auto';
document.querySelector('.mobile-nav').style.pointerEvents = 'auto';
viewChat.style.pointerEvents = 'auto';
viewTuner.style.pointerEvents = 'auto';

// Resize visualizer canvas
function resizeCanvas() {
  if (visualizerCanvas.parentElement) {
    const parentWidth = visualizerCanvas.parentElement.clientWidth || window.innerWidth - 40;
    visualizerCanvas.width = parentWidth;
    visualizerCanvas.height = 55;
  }
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ==========================================
// 1. TAB CONTROLLER LOGIC
// ==========================================
const navTabs = document.querySelectorAll('.nav-tab');

navTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const selectedTab = tab.dataset.tab;
    
    // Toggle active classes on tab buttons
    navTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Toggle active view panels
    const viewId = `view-${selectedTab}`;
    const views = document.querySelectorAll('.mobile-view');
    views.forEach(v => {
      v.classList.remove('active');
      if (v.id === viewId) {
        v.classList.add('active');
      }
    });

    // Control Globe accessibility & pointer events depending on active tab
    if (selectedTab === 'globe') {
      globeContainerMobile.style.pointerEvents = 'auto';
      globeContainerMobile.style.opacity = '1';
    } else {
      globeContainerMobile.style.pointerEvents = 'none';
      if (selectedTab === 'chat') {
        globeContainerMobile.style.opacity = '0.3'; // dim background on chat
      } else {
        globeContainerMobile.style.opacity = '0.4';
      }
    }

    // Trigger visualizer canvas resize if tuner tab is activated (prevents 0-width rendering)
    if (selectedTab === 'tuner') {
      setTimeout(resizeCanvas, 50);
    }
  });
});

// Default opacity settings on startup
globeContainerMobile.style.opacity = '0.3';

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
      appendTraceLog('thought', `[Thought] ${content}`);
      break;

    case 'tool_call':
      appendTraceLog('tool_call', `[Tool Call] searching for "${call.args.query}"`);
      break;

    case 'tool_result':
      appendTraceLog('tool_result', `[Tool Result] Verified ${result.playableCount || 0} playable stations.`);
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
  activeAgentMessageEl.querySelector('.message-content').innerHTML = parseSimpleMarkdown(currentAgentText);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function finalizeAgentMessage() {
  const regex = /```json-stations\s*([\s\S]*?)\s*```/;
  const match = currentAgentText.match(regex);
  if (match) {
    try {
      const stations = JSON.parse(match[1].trim());
      updateDiscoveredStations(stations);
      
      // Auto switch tabs to tuner console to show discovered list on mobile
      setTimeout(() => {
        const tunerTabButton = document.querySelector('.nav-tab[data-tab="tuner"]');
        if (tunerTabButton) tunerTabButton.click();
      }, 1500);

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

  // Map incoming stations to coordinates and playing state
  const newStationsMapped = stations.map(station => {
    const coords = getCoordinatesForLocation(station.location);
    return {
      ...station,
      lat: coords ? coords[0] : 0,
      lng: coords ? coords[1] : 0,
      isPlaying: currentlyPlayingStation && currentlyPlayingStation.url === station.url
    };
  });

  // Append new unique stations (checking by URL)
  newStationsMapped.forEach(newStation => {
    const isDuplicate = discoveredStationsData.some(existing => existing.url === newStation.url);
    if (!isDuplicate) {
      discoveredStationsData.push(newStation);
    }
  });

  // Keep the isPlaying flag updated for all stations in discoveredStationsData
  discoveredStationsData.forEach(station => {
    station.isPlaying = currentlyPlayingStation && currentlyPlayingStation.url === station.url;
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
      // Switch tab to Globe
      const globeTabButton = document.querySelector('.nav-tab[data-tab="globe"]');
      if (globeTabButton) globeTabButton.click();

      // Orbit camera over this location
      if (globeInstance && (station.lat !== 0 || station.lng !== 0)) {
        setTimeout(() => {
          globeInstance.pointOfView({ lat: station.lat, lng: station.lng, altitude: 1.8 }, 1200);
        }, 300);
      }
    });

    stationsList.appendChild(card);
  });

  // Load points into Globe
  if (globeInstance) {
    globeInstance.pointsData(discoveredStationsData);
  }
}

// Sanitizers and Markdown Parsers
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function parseSimpleMarkdown(md) {
  let html = escapeHTML(md);
  const codeBlocks = [];
  
  html = html.replace(/```(json-stations|json|javascript|typescript|bash|css|html)?\s*([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const placeholder = `\n\n__CODE_BLOCK_${codeBlocks.length}__\n\n`;
    codeBlocks.push(`<pre><code class="language-${lang || 'txt'}">${code}</code></pre>`);
    return placeholder;
  });
  
  let paragraphs = html.split(/\n\n+/);
  paragraphs = paragraphs.map(p => {
    let trimmed = p.trim();
    if (!trimmed) return '';
    if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  });
  html = paragraphs.filter(p => p !== '').join('');
  
  codeBlocks.forEach((codeBlockMarkup, index) => {
    html = html.replace(`__CODE_BLOCK_${index}__`, codeBlockMarkup);
  });
  
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  return html;
}

// ==========================================
// 3. AUDIO TUNING & PLAYBACK CONTROLS
// ==========================================

function tuneInStation(station) {
  currentlyPlayingStation = station;

  const randFreq = (Math.random() * (107.9 - 87.5) + 87.5).toFixed(1);
  tunerFrequency.textContent = `${randFreq} MHz`;

  // Update details display
  currentStationName.textContent = station.name;
  currentStationGenre.textContent = station.genre;
  currentStationLocation.textContent = station.location;
  currentStreamInfo.textContent = `Format: ${station.contentType || 'unknown'} | URL: ${station.url.substring(0, 35)}...`;

  playbackStatus.textContent = 'Connecting...';
  playPauseBtn.disabled = false;

  // Cleanup existing HLS
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  // Reload lists active tags
  document.querySelectorAll('.station-card-item').forEach(card => {
    if (card.dataset.url === station.url) {
      card.classList.add('active-playing');
      card.querySelector('.tune-in-btn').textContent = 'Playing';
    } else {
      card.classList.remove('active-playing');
      card.querySelector('.tune-in-btn').textContent = 'Tune In';
    }
  });

  const isHls = station.url.toLowerCase().includes('.m3u8') || 
                (station.contentType && (station.contentType.toLowerCase().includes('mpegurl') || station.contentType.toLowerCase().includes('hls')));

  if (isHls && window.Hls && Hls.isSupported()) {
    const proxyUrl = `/api/stream.m3u8?url=${encodeURIComponent(station.url)}`;
    hlsInstance = new Hls();
    hlsInstance.loadSource(proxyUrl);
    hlsInstance.attachMedia(audioElement);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      audioElement.play()
        .then(() => {
          playbackStatus.textContent = 'Playing';
          showPauseIcon();
          setupAudioContext();
          updateGlobePlayState(true);
        })
        .catch(err => {
          console.warn(err);
          playbackStatus.textContent = 'Error';
          showPlayIcon();
          updateGlobePlayState(false);
        });
    });
    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        playbackStatus.textContent = 'Error';
        showPlayIcon();
        updateGlobePlayState(false);
      }
    });
  } else {
    // Normal audio stream
    const proxyUrl = `/api/stream?url=${encodeURIComponent(station.url)}`;
    audioElement.src = proxyUrl;
    audioElement.load();
    audioElement.play()
      .then(() => {
        playbackStatus.textContent = 'Playing';
        showPauseIcon();
        setupAudioContext();
        updateGlobePlayState(true);
      })
      .catch(err => {
        console.warn(err);
        playbackStatus.textContent = 'Error / Offline';
        showPlayIcon();
        updateGlobePlayState(false);
      });
  }
}

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
        playbackStatus.textContent = 'Error';
        updateGlobePlayState(false);
      });
  } else {
    audioElement.pause();
    playbackStatus.textContent = 'Paused';
    showPlayIcon();
    updateGlobePlayState(false);
  }
});

// Audio listeners
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
audioElement.addEventListener('error', () => {
  playbackStatus.textContent = 'Error';
  showPlayIcon();
  updateGlobePlayState(false);
});

// Volume setup
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
  if (audioContext) return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 128; // Smaller for mobile performance optimization

    audioSource = audioContext.createMediaElementSource(audioElement);
    audioSource.connect(analyser);
    analyser.connect(audioContext.destination);
  } catch (err) {
    console.warn('[Visualizer] CORS fallback animation active.');
  }
}

let wavePhase = 0;
function drawVisualizer() {
  visualizerAnimationId = requestAnimationFrame(drawVisualizer);

  const width = visualizerCanvas.width;
  const height = visualizerCanvas.height;

  canvasCtx.clearRect(0, 0, width, height);

  // Background grid lines (optimized/spaced for mobile)
  canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
  canvasCtx.lineWidth = 1;
  for (let i = 40; i < width; i += 60) {
    canvasCtx.beginPath();
    canvasCtx.moveTo(i, 0);
    canvasCtx.lineTo(i, height);
    canvasCtx.stroke();
  }

  const isPlaying = !audioElement.paused && !audioElement.muted && audioElement.readyState >= 2;
  let dataArray = null;

  if (analyser && isPlaying) {
    try {
      const bufferLength = analyser.frequencyBinCount;
      dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);
    } catch (e) {
      dataArray = null;
    }
  }

  const drawWave = (amplitudeFactor, frequency, speed, colorHex, lineWidth) => {
    canvasCtx.strokeStyle = colorHex;
    canvasCtx.lineWidth = lineWidth;
    canvasCtx.beginPath();

    wavePhase += speed;
    const sliceWidth = width / 50; // Fewer slices for mobile processing efficiency
    let x = 0;

    for (let i = 0; i <= 50; i++) {
      let amp = 2; 
      if (isPlaying) {
        if (dataArray) {
          const dataIndex = Math.floor((i / 50) * dataArray.length);
          amp = 3 + (dataArray[dataIndex] || 0) * 0.15 * amplitudeFactor;
        } else {
          amp = 6 + (Math.sin(wavePhase * 0.5) + 1.5) * 5 * amplitudeFactor;
        }
      }

      const fade = Math.sin((i / 50) * Math.PI);
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

  if (isPlaying) {
    // Neon Purple
    drawWave(1.0, 0.18, 0.08, 'rgba(191, 90, 242, 0.75)', 2);
    // Neon Cyan
    drawWave(0.7, 0.25, -0.06, 'rgba(90, 200, 250, 0.65)', 1.2);
  } else {
    drawWave(0.1, 0.05, 0.005, 'rgba(94, 107, 125, 0.25)', 1);
  }
}
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

async function loadCountryCoords() {
  let cached = null;
  try {
    cached = localStorage.getItem('world_radio_country_coords');
  } catch (e) {
    console.warn('[Storage] localstorage access denied:', e);
  }
  
  if (cached) {
    try {
      countryCoordsMap = JSON.parse(cached);
      return;
    } catch (e) {
      console.error(e);
    }
  }
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
        if (name && latlng && latlng.length === 2) freshMap[name] = latlng;
        if (official && latlng && latlng.length === 2) freshMap[official] = latlng;
      });
      countryCoordsMap = freshMap;
      try {
        localStorage.setItem('world_radio_country_coords', JSON.stringify(freshMap));
      } catch (e) {
        console.warn('[Storage] localstorage write denied:', e);
      }
    }
  } catch (err) {
    console.warn('Fallback coords loaded:', err.message);
  }
}

function getCoordinatesForLocation(location) {
  if (!location || typeof location !== 'string') return null;
  const parts = location.split(',').map(p => p.trim().toLowerCase());

  for (const part of parts) {
    if (countryCoordsMap[part]) return countryCoordsMap[part];
  }
  for (const part of parts) {
    if (part.includes('usa') || part.includes('united states') || part.includes('us')) return countryCoordsMap['united states'];
    if (part.includes('uk') || part.includes('united kingdom') || part.includes('england')) return countryCoordsMap['united kingdom'];
    if (part.includes('russia')) return countryCoordsMap['russia'];
    if (part.includes('korea')) return countryCoordsMap['south korea'];
  }
  for (const part of parts) {
    for (const countryName of Object.keys(countryCoordsMap)) {
      if (part.includes(countryName) || countryName.includes(part)) return countryCoordsMap[countryName];
    }
  }
  let hash = 0;
  for (let i = 0; i < location.length; i++) {
    hash = location.charCodeAt(i) + ((hash << 5) - hash);
  }
  const lat = ((hash % 60) + 10) / 2; // Mobile coordinates geocode deterministic spread
  const lng = ((hash % 160) + 10) / 2;
  return [lat, lng];
}

function initGlobe() {
  const container = document.getElementById('globe-container-mobile');
  if (!container) return;

  if (typeof Globe === 'undefined') {
    console.warn('[Globe] Globe.gl library is not loaded. 3D Globe visualization disabled.');
    return;
  }

  // Check for WebGL context support to avoid crashing on older mobile devices / low power modes
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      console.warn('[WebGL] WebGL is not supported on this browser. 3D Globe visualization disabled.');
      return;
    }
  } catch (e) {
    console.warn('[WebGL] WebGL capability check failed. 3D Globe visualization disabled:', e);
    return;
  }

  globeInstance = Globe()(container)
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundImageUrl('//unpkg.com/three-globe/example/img/night-sky.png')
    .backgroundColor('rgba(0, 0, 0, 0)')
    .width(window.innerWidth)
    .height(window.innerHeight)
    .pointColor(() => '#5ac8fa')
    .pointAltitude(0.04)
    .pointRadius(0.35)
    .pointsMerge(false)
    .pointLabel(s => `
      <div style="background: rgba(10,12,16,0.85); color:#f5f6f8; border: 1px solid rgba(255,255,255,0.1); padding:6px 10px; border-radius:6px; font-family:sans-serif; font-size:12px;">
        <strong>${escapeHTML(s.name)}</strong><br/>
        <span style="color:#5ac8fa;">${escapeHTML(s.genre)}</span> · <span style="color:#9aa5b5;">${escapeHTML(s.location)}</span>
      </div>
    `);

  // Ring markers on active points
  globeInstance
    .ringsData([])
    .ringColor(() => '#bf5af2')
    .ringMaxRadius(4)
    .ringPropagationSpeed(1.8)
    .ringRepeatNum(2);

  // Setup click pin listener
  globeInstance.onPointClick((station) => {
    // Tune in the station and show tuner panel
    tuneInStation(station);
    const tunerTabButton = document.querySelector('.nav-tab[data-tab="tuner"]');
    if (tunerTabButton) tunerTabButton.click();
  });

  // Handle window resizing
  window.addEventListener('resize', () => {
    globeInstance.width(window.innerWidth).height(window.innerHeight);
  });
}

function updateGlobePlayState(isPlaying) {
  if (!globeInstance || !currentlyPlayingStation) return;
  
  if (isPlaying) {
    const lat = currentlyPlayingStation.lat || 0;
    const lng = currentlyPlayingStation.lng || 0;
    globeInstance.ringsData([{ lat, lng }]);
  } else {
    globeInstance.ringsData([]);
  }
}

// Initializer
(async function initApp() {
  await loadCountryCoords();
  initGlobe();
})();
