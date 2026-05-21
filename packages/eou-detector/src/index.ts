export class SemanticEouDetector {
  private trailingNonEouWords = new Set([
    'and', 'but', 'or', 'so', 'because', 'although', 'if',
    'to', 'for', 'with', 'at', 'from', 'by', 'about',
    'my', 'your', 'his', 'her', 'their', 'our', 'its',
    'the', 'a', 'an',
    'um', 'uh', 'ah', 'like', 'i', 'we', 'he', 'she', 'they',
    'want', 'need', 'wish', 'please'
  ]);

  isEndOfUtterance(transcript: string, silenceDurationMs: number): boolean {
    const trimmed = transcript.trim().toLowerCase();
    if (!trimmed) {
      return false;
    }

    if (silenceDurationMs >= 1800) {
      return true;
    }

    if (silenceDurationMs < 500) {
      return false;
    }

    const words = trimmed.split(/\s+/);
    const lastWord = words[words.length - 1];
    const cleanLastWord = lastWord.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, '');

    if (this.trailingNonEouWords.has(cleanLastWord)) {
      return silenceDurationMs >= 1200;
    }

    if (words.length >= 2) {
      const lastTwo = words.slice(-2).join(' ').replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, '');
      const nonEouPhrases = ['want to', 'going to', 'i would', 'could you', 'would you'];
      if (nonEouPhrases.includes(lastTwo)) {
        return silenceDurationMs >= 1200;
      }
    }

    return silenceDurationMs >= 600;
  }
}
