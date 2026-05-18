export type LocalAIProvider = 'ollama' | 'lmstudio' | 'argos';

export interface LocalAIConfig {
  provider?: LocalAIProvider;
  ollamaBaseUrl?: string;
  lmStudioBaseUrl?: string;
  lmStudioApiKey?: string;
  argosPythonPath?: string;
}

export interface LocalAIModel {
  id: string;
  label: string;
}

export interface LocalLanguageInfo {
  language_code: string;
  language_name: string;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';

export const LOCAL_LANGUAGES: LocalLanguageInfo[] = [
  { language_code: 'auto', language_name: 'Auto-detect' },
  { language_code: 'en', language_name: 'English' },
  { language_code: 'es', language_name: 'Spanish' },
  { language_code: 'fr', language_name: 'French' },
  { language_code: 'de', language_name: 'German' },
  { language_code: 'it', language_name: 'Italian' },
  { language_code: 'pt', language_name: 'Portuguese' },
  { language_code: 'nl', language_name: 'Dutch' },
  { language_code: 'ru', language_name: 'Russian' },
  { language_code: 'ja', language_name: 'Japanese' },
  { language_code: 'ko', language_name: 'Korean' },
  { language_code: 'zh', language_name: 'Chinese' },
  { language_code: 'ar', language_name: 'Arabic' },
  { language_code: 'hi', language_name: 'Hindi' },
  { language_code: 'tr', language_name: 'Turkish' },
  { language_code: 'pl', language_name: 'Polish' },
  { language_code: 'sv', language_name: 'Swedish' },
  { language_code: 'da', language_name: 'Danish' },
  { language_code: 'fi', language_name: 'Finnish' },
  { language_code: 'no', language_name: 'Norwegian' },
  { language_code: 'cs', language_name: 'Czech' },
  { language_code: 'el', language_name: 'Greek' },
  { language_code: 'he', language_name: 'Hebrew' },
  { language_code: 'id', language_name: 'Indonesian' },
  { language_code: 'th', language_name: 'Thai' },
  { language_code: 'vi', language_name: 'Vietnamese' },
  { language_code: 'uk', language_name: 'Ukrainian' }
];

const LANGUAGE_NAMES = new Map(LOCAL_LANGUAGES.map(lang => [lang.language_code, lang.language_name]));

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:srt|vtt|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function splitSubtitleContent(content: string, maxChars = 12000): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [content];
}

function safeJsonParse(text: string): any | null {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? tryParse(match[0]) : null;
}

function tryParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class LocalAIService {
  private config: Required<LocalAIConfig>;
  private resultStore = new Map<string, string>();

  constructor(config: LocalAIConfig = {}) {
    this.config = {
      provider: config.provider || 'ollama',
      ollamaBaseUrl: config.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
      lmStudioBaseUrl: config.lmStudioBaseUrl || DEFAULT_LM_STUDIO_BASE_URL,
      lmStudioApiKey: config.lmStudioApiKey || '',
      argosPythonPath: config.argosPythonPath || ''
    };
  }

  get provider(): LocalAIProvider {
    return this.config.provider;
  }

  async listModels(): Promise<LocalAIModel[]> {
    if (this.config.provider === 'argos') {
      return [{ id: 'argos-local', label: 'Argos Translate (offline)' }];
    }

    if (this.config.provider === 'lmstudio') {
      return this.listLMStudioModels();
    }

    return this.listOllamaModels();
  }

  async translateSubtitleContent(content: string, model: string, sourceLanguage: string, targetLanguage: string): Promise<string> {
    if (this.config.provider === 'argos') {
      if (!window.electronAPI?.translateWithArgos) {
        throw new Error('Argos Translate is not available in this build.');
      }
      return window.electronAPI.translateWithArgos(content, sourceLanguage, targetLanguage);
    }

    const chunks = splitSubtitleContent(content);
    const translatedChunks: string[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const prompt = [
        `Translate this subtitle chunk from ${this.languageName(sourceLanguage)} to ${this.languageName(targetLanguage)}.`,
        'Preserve every subtitle number, timestamp, cue id, blank line, HTML tag, speaker label, and SRT/VTT structure.',
        'Translate only human-readable dialogue text. Return only the translated subtitle chunk, with no markdown.',
        chunks.length > 1 ? `Chunk ${index + 1} of ${chunks.length}:` : 'Subtitle content:',
        chunk
      ].join('\n\n');

      const translated = await this.complete(model, prompt, 'You are a subtitle translation engine. Return only valid subtitle text.');
      translatedChunks.push(stripCodeFences(translated));
    }

    return translatedChunks.join('\n\n');
  }

  async detectTextLanguage(content: string, model: string): Promise<{ language_code: string; language_name: string }> {
    if (this.config.provider === 'argos') {
      throw new Error('Argos Translate does not provide language detection. Select the source language manually.');
    }

    const sample = content.slice(0, 5000);
    const prompt = [
      'Detect the main language of this subtitle/text sample.',
      'Return JSON only in this exact shape: {"language_code":"en","language_name":"English"}',
      sample
    ].join('\n\n');

    const response = await this.complete(model, prompt, 'You detect languages and return compact JSON only.');
    const parsed = safeJsonParse(response);
    const code = typeof parsed?.language_code === 'string' ? parsed.language_code : 'auto';
    const name = typeof parsed?.language_name === 'string' ? parsed.language_name : this.languageName(code);
    return { language_code: code, language_name: name };
  }

  storeResult(content: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.resultStore.set(id, content);
    return `local-ai://result/${id}`;
  }

  getStoredResult(url: string): string | null {
    const prefix = 'local-ai://result/';
    if (!url.startsWith(prefix)) return null;
    return this.resultStore.get(url.slice(prefix.length)) || null;
  }

  private languageName(code: string): string {
    if (!code || code === 'auto') return 'the detected source language';
    return LANGUAGE_NAMES.get(code) || code;
  }

  private async listOllamaModels(): Promise<LocalAIModel[]> {
    const baseUrl = normalizeBaseUrl(this.config.ollamaBaseUrl);
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama model list failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.models || []).map((model: any) => ({
      id: model.name || model.model,
      label: model.name || model.model
    })).filter((model: LocalAIModel) => !!model.id);
  }

  private async listLMStudioModels(): Promise<LocalAIModel[]> {
    const baseUrl = normalizeBaseUrl(this.config.lmStudioBaseUrl);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.config.lmStudioApiKey) {
      headers.Authorization = `Bearer ${this.config.lmStudioApiKey}`;
    }

    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
      throw new Error(`LM Studio model list failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.data || []).map((model: any) => ({
      id: model.id,
      label: model.id
    })).filter((model: LocalAIModel) => !!model.id);
  }

  private async complete(model: string, prompt: string, system: string): Promise<string> {
    if (this.config.provider === 'argos') {
      throw new Error('Argos Translate does not use chat completions.');
    }

    if (this.config.provider === 'lmstudio') {
      return this.completeWithLMStudio(model, prompt, system);
    }

    return this.completeWithOllama(model, prompt, system);
  }

  private async completeWithOllama(model: string, prompt: string, system: string): Promise<string> {
    const baseUrl = normalizeBaseUrl(this.config.ollamaBaseUrl);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        options: {
          temperature: 0.1
        }
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    const data = await response.json();
    return data.message?.content || data.response || '';
  }

  private async completeWithLMStudio(model: string, prompt: string, system: string): Promise<string> {
    const baseUrl = normalizeBaseUrl(this.config.lmStudioBaseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    if (this.config.lmStudioApiKey) {
      headers.Authorization = `Bearer ${this.config.lmStudioApiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LM Studio request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }
}
