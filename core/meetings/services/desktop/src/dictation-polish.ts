export interface DictationPolishOptions {
  gatewayUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export const TRANSLATION_LANGUAGES = ['en', 'vi', 'ja', 'ko', 'zh-CN', 'es', 'fr', 'de'] as const;
export type TranslationLanguage = typeof TRANSLATION_LANGUAGES[number];

export function supportsTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && TRANSLATION_LANGUAGES.includes(value as TranslationLanguage);
}

async function transcriptCompletion(
  text: string,
  options: DictationPolishOptions,
  task: 'polish' | 'translate',
  targetLanguage?: TranslationLanguage,
): Promise<string> {
  const transcript = text.trim();
  const label = task === 'polish' ? 'Text polish' : 'Live translation';
  const maxLength = task === 'polish' ? 50_000 : 10_000;
  if (!transcript || transcript.length > maxLength) throw new Error('Invalid dictation text');
  if (task === 'translate' && !targetLanguage) throw new Error('Unsupported translation language');
  if (!options.apiKey) throw new Error(`${label} is not configured`);

  let gateway: URL;
  try {
    gateway = new URL(options.gatewayUrl);
  } catch {
    throw new Error(`${label} is not configured`);
  }
  const hostname = gateway.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if ((gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && loopback))
      || gateway.username || gateway.password) {
    throw new Error(`${label} is not configured`);
  }
  gateway.pathname = `${gateway.pathname.replace(/\/+$/, '')}/agent/dictation/${task}`;
  gateway.search = '';
  gateway.hash = '';

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(gateway, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': options.apiKey },
      body: JSON.stringify(task === 'polish'
        ? { text: transcript }
        : { text: transcript, target_language: targetLanguage }),
      redirect: 'error',
      signal: AbortSignal.timeout(65_000),
    });
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!response.ok) throw new Error(`${label} is unavailable`);

  let body: unknown;
  try {
    const encoded = await response.text();
    if (new TextEncoder().encode(encoded).length > 256 * 1024) throw new Error('Response too large');
    body = JSON.parse(encoded);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  const field = task === 'polish' ? 'polished_text' : 'translated_text';
  const output = body && typeof body === 'object'
    ? (body as Record<string, unknown>)[field]
    : null;
  if (typeof output !== 'string' || !output.trim() || output.length > 50_000) {
    throw new Error(`${label} is unavailable`);
  }
  return output.trim();
}

export function polishDictationText(text: string, options: DictationPolishOptions): Promise<string> {
  return transcriptCompletion(text, options, 'polish');
}

export function translateTranscriptText(
  text: string,
  targetLanguage: TranslationLanguage,
  options: DictationPolishOptions,
): Promise<string> {
  return transcriptCompletion(text, options, 'translate', targetLanguage);
}
