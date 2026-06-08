'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  PhoneCall,
  PhoneOff,
  Calendar,
  User,
  CheckCircle,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { Room, RoomEvent, ConnectionState, Track } from 'livekit-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

export default function Home() {
  const [tenantId, setTenantId] = useState('d3b07384-d113-4ec3-a558-e04e662e3f62');
  const [roomId, setRoomId] = useState('');
  const [status, setStatus] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [transcript, setTranscript] = useState<Array<{ role: 'user' | 'agent'; text: string; ts: number }>>([]);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  // Cancellation state
  const [cancelCode, setCancelCode] = useState('');
  const [cancelRoomId, setCancelRoomId] = useState('');
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelMessage, setCancelMessage] = useState('');
  const [cancelSuccess, setCancelSuccess] = useState<boolean | null>(null);

  const roomRef = useRef<Room | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const handleConnect = async () => {
    if (status !== ConnectionState.Disconnected) return;

    setStatus(ConnectionState.Connecting);
    setTranscript([]);

    try {
      // 1. Fetch token and room configuration from API Gateway
      const res = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, channel: 'web' }),
      });

      if (!res.ok) {
        throw new Error('Failed to create session');
      }

      const data = await res.json();
      const { token, roomId: responseRoomId, serverUrl } = data;
      setRoomId(responseRoomId);
      setCancelRoomId(responseRoomId);

      // 2. Connect to LiveKit Room
      const room = new Room({
        // audio-only room optimizations
        videoCaptureDefaults: undefined,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      roomRef.current = room;

      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        setStatus(state);
      });

      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const str = new TextDecoder().decode(payload);
          const msg = JSON.parse(str);
          if (msg.type === 'transcript') {
            setTranscript((prev) => [...prev, { role: msg.role, text: msg.text, ts: Date.now() }]);
          } else if (msg.type === 'speaking') {
            if (msg.role === 'agent') {
              setIsAgentSpeaking(msg.isSpeaking);
            } else {
              setIsUserSpeaking(msg.isSpeaking);
            }
          }
        } catch (e) {
          console.error('Error parsing room message:', e);
        }
      });

      room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        for (const segment of segments) {
          // We only append final transcripts to the log to avoid duplicating in-progress text
          if (segment.final) {
            // Distinguish agent vs user. Usually agent identity contains 'agent' or 'server'
            const role = participant?.identity?.toLowerCase().includes('agent') ? 'agent' : 'user';
            setTranscript((prev) => [...prev, { role, text: segment.text, ts: Date.now() }]);
          }
        }
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const agentSpeaking = speakers.some(p => p.identity?.toLowerCase().includes('agent'));
        const userSpeaking = speakers.some(p => !p.identity?.toLowerCase().includes('agent'));
        setIsAgentSpeaking(agentSpeaking);
        setIsUserSpeaking(userSpeaking);
      });

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const audioElement = track.attach();
          document.body.appendChild(audioElement);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
      });

      await room.connect(serverUrl, token);
      setStatus(ConnectionState.Connected);

      // Turn on local microphone
      await room.localParticipant.setMicrophoneEnabled(true);

      // Welcome message placeholder (in case agent takes time to boot)
      setTranscript([
        { role: 'agent', text: 'Initializing secure voice channel with booking coordinator...', ts: Date.now() },
      ]);
    } catch (err) {
      console.error('Connection error:', err);
      setStatus(ConnectionState.Disconnected);
      alert('Could not establish connection to the voice gateway.');
    }
  };

  const handleDisconnect = async () => {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    setStatus(ConnectionState.Disconnected);
    setIsAgentSpeaking(false);
    setIsUserSpeaking(false);
  };

  const handleCancelBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelCode || !cancelRoomId) {
      setCancelMessage('Please fill all cancellation fields.');
      setCancelSuccess(false);
      return;
    }

    setCancelLoading(true);
    setCancelMessage('');
    setCancelSuccess(null);

    try {
      const res = await fetch(`${API_URL}/api/bookings/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          confirmationCode: cancelCode,
          roomId: cancelRoomId,
        }),
      });

      if (!res.ok) {
        throw new Error('Cancellation dispatch failed');
      }

      setCancelSuccess(true);
      setCancelMessage('Cancellation request received. Processing via saga workflow...');
    } catch {
      setCancelSuccess(false);
      setCancelMessage('Failed to submit cancellation. Please check details.');
    } finally {
      setCancelLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">
          <Calendar size={24} /> Voice Agent
        </h1>

        <div className="flex items-center gap-4">
          {status === ConnectionState.Connected && (
            <div className="badge badge-connected">
              <CheckCircle size={16} />
              CONNECTED: {roomId}
            </div>
          )}
          {status === ConnectionState.Connecting && (
            <div className="badge badge-connecting">
              <RefreshCw size={14} className="animate-spin" />
              ESTABLISHING CHANNEL...
            </div>
          )}
          {status === ConnectionState.Disconnected && (
            <div className="badge badge-disconnected">
              OFFLINE
            </div>
          )}
        </div>
      </header>

      {/* Main Layout */}
      <main className="main-layout">
        {/* Left Side: Voice Sphere & Configuration */}
        <div className="flex flex-col gap-6">
          {/* Sphere Panel */}
          <div className="glass-panel voice-section">
            {/* Visualizer ripple rings */}
            <div className={`visualizer-ring ${isAgentSpeaking ? 'animate' : ''}`} style={{ borderColor: 'var(--accent-secondary)' }} />
            <div className={`visualizer-ring ${isUserSpeaking ? 'animate' : ''}`} style={{ borderColor: 'var(--accent-primary)', animationDelay: '0.6s' }} />

            <div
              className={`visualizer-sphere ${status === ConnectionState.Connected ? 'active' : ''}`}
              onClick={status === ConnectionState.Connected ? handleDisconnect : handleConnect}
            >
              {status === ConnectionState.Connected ? (
                <PhoneOff size={42} color="white" />
              ) : (
                <PhoneCall size={42} color="white" />
              )}
            </div>

            <div className="text-center mt-6 z-10">
              <p className="font-semibold text-lg">
                {status === ConnectionState.Connected
                  ? isAgentSpeaking
                    ? 'Agent is speaking...'
                    : isUserSpeaking
                    ? 'Listening to you...'
                    : 'Call connected. Ask anything.'
                  : 'Start voice session'}
              </p>
              <p className="text-xs text-secondary mt-1">
                {status === ConnectionState.Connected
                  ? 'Click sphere to hang up'
                  : 'Click sphere to initiate live audio connection'}
              </p>
            </div>
          </div>

          {/* Configuration Panel */}
          <div className="glass-panel">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <User size={18} /> Tenant Configuration
            </h2>

            <div className="form-group">
              <label className="form-label">Tenant ID</label>
              <input
                type="text"
                className="form-input"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="Enter tenant UUID"
                disabled={status !== ConnectionState.Disconnected}
              />
            </div>
            <p className="info-text">
              Changing Tenant ID shifts the agent voice models, calendars, and systems settings instantly via Redis cache sync.
            </p>
          </div>
        </div>

        {/* Right Side: Sidebar Transcript & Cancellation Form */}
        <div className="flex flex-col gap-6">
          {/* Transcript Panel */}
          <div className="glass-panel flex-1 flex flex-col" style={{ minHeight: '380px' }}>
            <div className="transcript-header">
              <span>Live Conversation Transcript</span>
              <span className="text-xs text-secondary">{transcript.length} turns</span>
            </div>

            <div className="transcript-list flex-1">
              {transcript.map((item, idx) => (
                <div
                  key={idx}
                  className={`transcript-bubble ${
                    item.role === 'user' ? 'bubble-user' : 'bubble-agent'
                  }`}
                >
                  <p>{item.text}</p>
                  <span className="bubble-time">
                    {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Cancellation Panel */}
          <div className="glass-panel">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <XCircle size={18} /> Cancel Reservation
            </h2>

            <form onSubmit={handleCancelBooking} className="flex flex-col gap-4">
              <div className="form-group">
                <label className="form-label">Confirmation Code</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="CONF-XXXXXX"
                  value={cancelCode}
                  onChange={(e) => setCancelCode(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Session Room ID</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="room-xxxxxxxx-xxxx"
                  value={cancelRoomId}
                  onChange={(e) => setCancelRoomId(e.target.value)}
                />
              </div>

              <button type="submit" className="action-btn btn-secondary w-full" disabled={cancelLoading}>
                {cancelLoading ? 'Cancelling...' : 'Request Saga Cancellation'}
              </button>
            </form>

            {cancelMessage && (
              <div
                className={`badge w-full justify-center p-3 text-sm ${
                  cancelSuccess ? 'badge-connected' : 'badge-disconnected'
                }`}
              >
                {cancelSuccess ? <CheckCircle size={16} /> : <XCircle size={16} />}
                {cancelMessage}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
