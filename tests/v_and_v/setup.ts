import { DefaultLogger, Runtime } from '@temporalio/worker';

try {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
} catch {
  // Another test module may already have initialized the Temporal runtime.
}
