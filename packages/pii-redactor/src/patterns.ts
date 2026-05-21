export interface PiiPattern {
  regex: RegExp;
  replacement: string;
}

export const PII_PATTERNS: PiiPattern[] = [
  // Phone numbers (India + International)
  { regex: /(\+91|0)?[6-9]\d{9}/g, replacement: '[PHONE]' },
  { regex: /\+1?\s*\(?\d{3}\)?\s*[-.]?\d{3}[-.]?\d{4}/g, replacement: '[PHONE]' },
  // Email addresses
  { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  // Credit cards
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CARD]' },
  // Aadhaar card (India 12-digit UID)
  { regex: /\b\d{4}\s\d{4}\s\d{4}\b/g, replacement: '[AADHAAR]' },
  { regex: /\b\d{12}\b/g, replacement: '[AADHAAR]' },
  // PAN card (India)
  { regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replacement: '[PAN]' },
];
