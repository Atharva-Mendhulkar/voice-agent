import WebSocket from 'ws';
import EventEmitter from 'events';

export interface CartesiaStreamingOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  sampleRate?: number;
  endpoint?: string;
}

export class CartesiaStreamingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<Omit<CartesiaStreamingOptions, 'endpoint'>> & { endpoint?: string };
  private retryCount = 0;
  private maxRetries = 5;
  private isClosedIntentional = false;

  constructor(options: CartesiaStreamingOptions) {
    super();
    this.options = {
      apiKey: options.apiKey,
      voiceId: options.voiceId,
      modelId: options.modelId || 'sonic-english',
      sampleRate: options.sampleRate || 16000,
      endpoint: options.endpoint,
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { apiKey, endpoint } = this.options;
      const baseUrl = endpoint || 'wss://api.cartesia.ai/tts/websocket';
      const url = `${baseUrl}?api_key=${apiKey}&client_version=2024-06-10`;

      this.isClosedIntentional = false;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.emit('open');
        this.retryCount = 0; // reset on success
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString());
          const { context_id, audio, status } = parsed;

          if (audio) {
            const buffer = Buffer.from(audio, 'base64');
            this.emit('audio', buffer, context_id);
          }

          if (status === 'done') {
            this.emit('done', context_id);
          }
        } catch (err) {
          this.emit('error', new Error('Failed to parse Cartesia message: ' + (err as Error).message));
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
            console.warn(`Cartesia disconnected unexpectedly. Reconnecting attempt ${this.retryCount} in ${backoff}ms...`);
            setTimeout(() => {
              this.connect().catch((err) => this.emit('error', err));
            }, backoff);
          } else {
            console.error('Cartesia disconnected unexpectedly. Max reconnect attempts reached.');
            this.emit('degraded', new Error('Cartesia TTS service unavailable. Degraded mode active.'));
          }
        }
      });
    });
  }

  sendTextChunk(contextId: string, text: string, isLast = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Degraded Mode: Emit warning to log that text chunk was dropped or should fall back to logs
      console.warn(`Cartesia WebSocket not open. Text chunk was not synthesized: "${text}"`);
      return;
    }

    const payload = {
      model_id: this.options.modelId,
      transcript: text,
      voice: {
        mode: 'id',
        id: this.options.voiceId,
      },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: this.options.sampleRate,
      },
      context_id: contextId,
      continue: !isLast,
    };

    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    this.isClosedIntentional = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }
}
