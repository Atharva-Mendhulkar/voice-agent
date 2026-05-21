import { PII_PATTERNS } from './patterns.js';

export class PiiRedactor {
  redact(text: string): string {
    if (!text) return '';
    let result = text;
    for (const { regex, replacement } of PII_PATTERNS) {
      result = result.replace(regex, replacement);
    }
    return result;
  }

  /**
   * Must be called BEFORE OTel span emission and BEFORE LLM context append
   */
  redactTranscriptChunk(chunk: string): string {
    return this.redact(chunk);
  }
}
