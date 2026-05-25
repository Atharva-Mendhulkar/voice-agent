import { NodeSDK } from '@opentelemetry/sdk-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { trace, metrics } from '@opentelemetry/api';
import { Langfuse } from 'langfuse';
import { pino } from 'pino';
import { PiiRedactor } from '@voice-agent/pii-redactor';

const piiRedactor = new PiiRedactor();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: {
    logMethod(inputArgs, method, level) {
      if (inputArgs.length > 0) {
        // Handle object payload
        if (typeof inputArgs[0] === 'object' && inputArgs[0] !== null) {
          const obj = inputArgs[0] as any;
          if (obj.transcript) obj.transcript = piiRedactor.redact(obj.transcript);
          if (obj.text) obj.text = piiRedactor.redact(obj.text);
          if (obj.msg) obj.msg = piiRedactor.redact(obj.msg);
        }
        // Handle string message as second arg or first arg
        for (let i = 0; i < inputArgs.length; i++) {
          if (typeof inputArgs[i] === 'string') {
            inputArgs[i] = piiRedactor.redact(inputArgs[i] as string);
          }
        }
      }
      return method.apply(this, inputArgs as any);
    }
  }
});

let sdk: NodeSDK | null = null;
let langfuseClient: Langfuse | null = null;

export function initTelemetry(serviceName: string) {
  const prometheusPort = parseInt(process.env.PROMETHEUS_PORT || '9464', 10);
  const exporter = new PrometheusExporter({
    port: prometheusPort,
    preventServerStart: false,
  }, () => {
    console.log(`Prometheus metrics exporter running on http://localhost:${prometheusPort}/metrics`);
  });

  sdk = new NodeSDK({
    serviceName,
    metricReader: exporter,
  });

  sdk.start();

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com';

  if (publicKey && secretKey) {
    langfuseClient = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
    });
    console.log('Langfuse tracing client successfully initialized.');
  }

  return {
    sdk,
    langfuse: langfuseClient,
  };
}

export function getTracer(name: string) {
  return trace.getTracer(name);
}

export function getMeter(name: string) {
  return metrics.getMeter(name);
}

export function getLangfuse() {
  return langfuseClient;
}

export async function shutdownTelemetry() {
  if (sdk) {
    await sdk.shutdown();
    console.log('Telemetry SDK shut down successfully.');
  }
  if (langfuseClient) {
    await langfuseClient.shutdownAsync();
    console.log('Langfuse tracing client shut down successfully.');
  }
}
