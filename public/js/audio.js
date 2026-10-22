'use strict';

/**
 * AudioEngine
 * -----------
 * Wraps every browser audio capability the app needs:
 *   - microphone capture (getUserMedia + MediaRecorder)
 *   - live waveform visualisation (Web Audio AnalyserNode)
 *   - speech recognition (Web Speech API, when available)
 *   - speech synthesis (Web Speech API) and playback of remote audio
 *
 * It performs no network requests itself; app.js handles provider calls.
 */
class AudioEngine {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.onLevel = options.onLevel || (() => {});
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});
    this.onRecognitionResult = options.onRecognitionResult || (() => {});
    this.onRecognitionError = options.onRecognitionError || (() => {});
    this.onRecognitionEnd = options.onRecognitionEnd || (() => {});

    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.sourceNode = null;
    this.rafId = null;
    this.recorder = null;
    this.recorderChunks = [];
    this.recognition = null;
    this.recognitionActive = false;
    this.recognitionManualStop = false;

    this.audioEl = new Audio();
    this.audioEl.preload = 'auto';
    this.currentUrl = null;
    this.playToken = 0;
    this.speaking = false;
    this.synthSpeaking = false;
    this.levelsActive = false;
  }

  /* ------------------------------------------------------------------ */
  /* Capabilities                                                        */
  /* ------------------------------------------------------------------ */
  capabilities() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return {
      getUserMedia: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      mediaRecorder: typeof window.MediaRecorder !== 'undefined',
      audioContext: typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined',
      speechRecognition: Boolean(SR),
      speechSynthesis: typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined',
      secureContext: window.isSecureContext,
      enumerateDevices: Boolean(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)
    };
  }

  async listMicrophones() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput').map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${d.deviceId.slice(0, 6)}`
    }));
  }

  listVoices() {
    if (typeof window.speechSynthesis === 'undefined') return [];
    return window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
  }

  /* ------------------------------------------------------------------ */
  /* Microphone + waveform                                               */
  /* ------------------------------------------------------------------ */
  async ensureStream(deviceId) {
    if (this.stream) {
      const tracks = this.stream.getAudioTracks();
      const currentId = tracks[0] && tracks[0].getSettings().deviceId;
      if (!deviceId || deviceId === currentId) return this.stream;
      this.releaseStream();
    }
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    return this.stream;
  }

  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.stopWaveform();
  }

  initAudioContext() {
    if (this.audioContext) return this.audioContext;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.audioContext = new Ctx();
    return this.audioContext;
  }

  startWaveform(mode = 'mic') {
    if (!this.canvas) return;
    if (mode === 'mic') {
      if (!this.stream) return;
      const ctx = this.initAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (!this.sourceNode || this.sourceNode._stream !== this.stream) {
        try {
          this.analyser = ctx.createAnalyser();
          this.analyser.fftSize = 512;
          this.analyser.smoothingTimeConstant = 0.75;
          this.sourceNode = ctx.createMediaStreamSource(this.stream);
          this.sourceNode._stream = this.stream;
          this.sourceNode.connect(this.analyser);
        } catch (_) {
          this.analyser = null;
        }
      }
      this.levelsActive = true;
      this._renderLoop();
    } else {
      this.levelsActive = false;
      this._renderSynthetic();
    }
  }

  stopWaveform() {
    this.levelsActive = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this._clearCanvas();
    this.onLevel(0);
  }

  _renderLoop() {
    const ctx = this.canvas.getContext('2d');
    const width = this.canvas.width;
    const height = this.canvas.height;
    const analyser = this.analyser;
    const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

    const draw = () => {
      if (!this.levelsActive) return;
      this.rafId = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, width, height);

      let level = 0;
      if (analyser && data) {
        analyser.getByteFrequencyData(data);
        const bars = 48;
        const step = Math.floor(data.length / bars) || 1;
        const barWidth = width / bars;
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4CAF50';
        for (let i = 0; i < bars; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += data[i * step + j] || 0;
          const avg = sum / step;
          level = Math.max(level, avg / 255);
          const barHeight = Math.max(3, (avg / 255) * height);
          const x = i * barWidth + barWidth * 0.2;
          const w = barWidth * 0.6;
          const y = (height - barHeight) / 2;
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.35 + (avg / 255) * 0.65;
          roundRect(ctx, x, y, w, barHeight, w / 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      this.onLevel(level);
    };
    draw();
  }

  _renderSynthetic() {
    const ctx = this.canvas.getContext('2d');
    const width = this.canvas.width;
    const height = this.canvas.height;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4CAF50';
    const start = performance.now();
    const draw = (now) => {
      if (this.levelsActive === false) return;
      this.rafId = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, width, height);
      const bars = 48;
      const barWidth = width / bars;
      const t = (now - start) / 1000;
      for (let i = 0; i < bars; i++) {
        const amp = (Math.sin(t * 6 + i * 0.5) * 0.5 + 0.5) * (0.35 + 0.65 * Math.abs(Math.sin(t * 2.2 + i * 0.15)));
        const barHeight = Math.max(3, amp * height);
        const x = i * barWidth + barWidth * 0.2;
        const w = barWidth * 0.6;
        const y = (height - barHeight) / 2;
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.4 + amp * 0.6;
        roundRect(ctx, x, y, w, barHeight, w / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      this.onLevel(0.5);
    };
    this.levelsActive = true;
    this.rafId = requestAnimationFrame(draw);
  }

  _clearCanvas() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /* ------------------------------------------------------------------ */
  /* Recording                                                           */
  /* ------------------------------------------------------------------ */
  pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      ''
    ];
    for (const type of candidates) {
      if (type === '') return '';
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  async startRecording(deviceId) {
    if (!window.MediaRecorder) throw new Error('Audio recording is not supported by this browser.');
    const stream = await this.ensureStream(deviceId);
    const mimeType = this.pickMimeType();
    this.recorderChunks = [];
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recorderChunks.push(e.data);
    };
    this.recorder.start(250);
    this.startWaveform('mic');
    return true;
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.stopWaveform();
        return resolve(null);
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.recorderChunks, { type: this.recorder.mimeType || 'audio/webm' });
        this.recorderChunks = [];
        resolve(blob.size > 0 ? blob : null);
      };
      try { this.recorder.stop(); } catch (_) { resolve(null); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Speech recognition (Web Speech API)                                 */
  /* ------------------------------------------------------------------ */
  createRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      this.onRecognitionResult({ final: finalText, interim });
    };
    recognition.onerror = (event) => {
      this.recognitionActive = false;
      this.onRecognitionError(event.error || 'recognition-error');
    };
    recognition.onend = () => {
      this.recognitionActive = false;
      this.onRecognitionEnd({ manual: this.recognitionManualStop });
      this.recognitionManualStop = false;
    };
    return recognition;
  }

  startRecognition({ continuous = false } = {}) {
    if (!this.createRecognition) return false;
    if (!this.recognition) this.recognition = this.createRecognition();
    if (!this.recognition) return false;
    if (this.recognitionActive) return true;
    this.recognition.continuous = Boolean(continuous);
    this.recognition.interimResults = true;
    this.recognitionManualStop = false;
    try {
      this.recognition.start();
      this.recognitionActive = true;
      this.startWaveform('mic');
      return true;
    } catch (_) {
      return false;
    }
  }

  stopRecognition() {
    if (this.recognition && this.recognitionActive) {
      this.recognitionManualStop = true;
      try { this.recognition.stop(); } catch (_) { /* ignore */ }
    }
    this.recognitionActive = false;
  }

  abortRecognition() {
    if (this.recognition) {
      try { this.recognition.abort(); } catch (_) { /* ignore */ }
    }
    this.recognitionActive = false;
  }

  /* ------------------------------------------------------------------ */
  /* Speech synthesis (browser)                                          */
  /* ------------------------------------------------------------------ */
  speakBrowser(text, { voiceName = '', rate = 1, pitch = 1, volume = 1 } = {}) {
    if (typeof window.speechSynthesis === 'undefined') {
      return Promise.reject(new Error('Browser speech synthesis is not available.'));
    }
    window.speechSynthesis.cancel();
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      if (voiceName) {
        const voice = window.speechSynthesis.getVoices().find((v) => v.name === voiceName);
        if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
      }
      utterance.onstart = () => {
        this.synthSpeaking = true;
        this.startWaveform('synth');
        this.onSpeechStart();
      };
      const finish = () => {
        this.synthSpeaking = false;
        this.stopWaveform();
        this.onSpeechEnd();
      };
      utterance.onend = () => { finish(); resolve(); };
      utterance.onerror = (e) => {
        finish();
        if (e.error === 'interrupted' || e.error === 'canceled') resolve();
        else reject(new Error(`Speech synthesis failed: ${e.error || 'unknown error'}`));
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Playback of remote audio blobs / urls                               */
  /* ------------------------------------------------------------------ */
  playBlob(blob) {
    const url = URL.createObjectURL(blob);
    return this.playUrl(url, true);
  }

  playUrl(url, revoke = false) {
    const token = ++this.playToken;
    return new Promise((resolve, reject) => {
      this.stopPlaybackInternal();
      this.currentUrl = revoke ? url : null;
      this.audioEl = new Audio();
      this.audioEl.preload = 'auto';
      this.audioEl.src = url;

      const cleanup = () => {
        if (this.currentUrl === url) this.currentUrl = null;
        if (revoke) URL.revokeObjectURL(url);
      };

      this.audioEl.onplay = () => {
        this.speaking = true;
        this.startWaveform('synth');
        this.onSpeechStart();
      };
      this.audioEl.onended = () => {
        if (token !== this.playToken) return;
        this.speaking = false;
        this.stopWaveform();
        cleanup();
        this.onSpeechEnd();
        resolve();
      };
      this.audioEl.onerror = () => {
        if (token !== this.playToken) return;
        this.speaking = false;
        this.stopWaveform();
        cleanup();
        this.onSpeechEnd();
        reject(new Error('Audio playback failed.'));
      };
      this.audioEl.play().catch((err) => {
        cleanup();
        this.speaking = false;
        this.stopWaveform();
        reject(new Error(`Could not start playback: ${err.message}`));
      });
    });
  }

  stopPlaybackInternal() {
    if (this.audioEl) {
      try { this.audioEl.pause(); } catch (_) { /* ignore */ }
      this.audioEl.onplay = this.audioEl.onended = this.audioEl.onerror = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.speaking = false;
  }

  stopSpeaking() {
    this.playToken++;
    this.stopPlaybackInternal();
    if (typeof window.speechSynthesis !== 'undefined') {
      window.speechSynthesis.cancel();
    }
    this.synthSpeaking = false;
    this.stopWaveform();
  }

  isSpeaking() {
    return this.speaking || this.synthSpeaking ||
      (typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.speaking);
  }

  /* ------------------------------------------------------------------ */
  /* Cleanup                                                             */
  /* ------------------------------------------------------------------ */
  destroy() {
    this.stopWaveform();
    this.stopSpeaking();
    this.abortRecognition();
    this.releaseStream();
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (_) { /* ignore */ }
      this.audioContext = null;
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

window.AudioEngine = AudioEngine;
