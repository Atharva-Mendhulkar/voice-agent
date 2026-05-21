import WebSocket from 'ws';
import EventEmitter from 'events';

export interface DeepgramStreamingOptions {
  apiKey: string;
  model?: string;
  encoding?: string;
  sampleRate?: number;
  language?: string;
  endpoint?: string;
}

export class DeepgramStreamingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<Omit<DeepgramStreamingOptions, 'endpoint'>> & { endpoint?: string };
  private retryCount = 0;
  private maxRetries = 5;
  private isClosedIntentional = false;

  constructor(options: DeepgramStreamingOptions) {
    super();
    this.options = {
      apiKey: options.apiKey,
      model: options.model || 'nova-3',
      encoding: options.encoding || 'linear16',
      sampleRate: options.sampleRate || 16000,
      language: options.language || 'en-US',
      endpoint: options.endpoint,
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { apiKey, model, encoding, sampleRate, language, endpoint } = this.options;
      const baseUrl = endpoint || 'wss://api.deepgram.com/v1/listen';
      const url = `${baseUrl}?model=${model}&encoding=${encoding}&sample_rate=${sampleRate}&language=${language}&interim_results=true&utterance_end_ms=1000`;

      this.isClosedIntentional = false;
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });

      this.ws.on('open', () => {
        this.emit('open');
        this.retryCount = 0; // reset on success
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString());
          const transcript = parsed.channel?.alternatives?.[0]?.transcript || '';
          const isFinal = parsed.is_final || false;
          
          if (transcript.trim()) {
            this.emit('transcript', transcript, isFinal);
          }
        } catch (err) {
          this.emit('error', new Error('Failed to parse Deepgram message: ' + (err as Error).message));
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        // Do not reject if we are already connected once and this is a runtime error
        if (this.retryCount === 0) {
          reject(err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.emit('close', code, reason.toString());

        if (!this.isClosedIntentional) {
          if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            const backoff = Math.pow(2, this.retryCount) * 500;
            console.warn(`Deepgram disconnected unexpectedly. Reconnecting attempt ${this.retryCount} in ${backoff}ms...`);
            setTimeout(() => {
              this.connect().catch((err) => this.emit('error', err));
            }, backoff);
          } else {
            console.error('Deepgram disconnected unexpectedly. Max reconnect attempts reached.');
            this.emit('degraded', new Error('Deepgram STT service unavailable. Degraded mode active.'));
          }
        }
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(chunk);
  }

  close(): void {
    this.isClosedIntentional = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (e) {
        // socket might be closed already
      }
      this.ws.close();
    }
    this.ws = null;
  }
}
