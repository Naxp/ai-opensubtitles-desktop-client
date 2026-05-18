import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface ArgosConfig {
  pythonPath?: string;
}

export interface ArgosLanguagePair {
  from: string;
  to: string;
}

const PYTHON_SCRIPT = String.raw`
import json
import sys
import argostranslate.translate

payload = json.load(sys.stdin)
mode = payload.get("mode")

if mode == "pairs":
    pairs = []
    for lang in argostranslate.translate.get_installed_languages():
        for translation in lang.translations_from:
            pairs.append({"from": lang.code, "to": translation.to_lang.code})
    print(json.dumps({"pairs": pairs}, ensure_ascii=False))
    raise SystemExit(0)

source = payload["source"]
target = payload["target"]
texts = payload.get("texts", [])

translated = [
    argostranslate.translate.translate(text, source, target)
    for text in texts
]
print(json.dumps({"translations": translated}, ensure_ascii=False))
`;

export class ArgosManager {
  constructor(private readonly userDataPath: string) {}

  getDefaultPythonPath(): string {
    const profilePath = path.join(this.userDataPath, 'local-argos', '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(profilePath)) {
      return profilePath;
    }

    return path.join(process.env.APPDATA || this.userDataPath, 'AI.Opensubtitles.com Client', 'local-argos', '.venv', 'Scripts', 'python.exe');
  }

  async listPairs(config: ArgosConfig = {}): Promise<ArgosLanguagePair[]> {
    const result = await this.runPython(config.pythonPath, { mode: 'pairs' });
    return Array.isArray(result.pairs) ? result.pairs : [];
  }

  async translateSubtitle(content: string, sourceLanguage: string, targetLanguage: string, config: ArgosConfig = {}): Promise<string> {
    const source = this.normalizeLanguageCode(sourceLanguage);
    const target = this.normalizeLanguageCode(targetLanguage);
    if (!source || source === 'auto') {
      throw new Error('Argos Translate requires an explicit source language. Auto-detect is not supported by the local Argos engine.');
    }

    if (!target || target === 'auto') {
      throw new Error('Argos Translate requires an explicit destination language.');
    }

    if (source === target) {
      return content;
    }

    const prepared = this.extractSubtitleTextSegments(content);
    if (prepared.texts.length === 0) {
      return content;
    }

    const result = await this.runPython(config.pythonPath, {
      mode: 'translate',
      source,
      target,
      texts: prepared.texts
    });
    const translations = Array.isArray(result.translations) ? result.translations : [];
    if (translations.length !== prepared.texts.length) {
      throw new Error(`Argos returned ${translations.length} translations for ${prepared.texts.length} subtitle text segments.`);
    }

    return prepared.rebuild(translations);
  }

  private async runPython(configuredPythonPath: string | undefined, payload: Record<string, unknown>): Promise<any> {
    const pythonPath = this.resolvePythonPath(configuredPythonPath);
    const input = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const child = spawn(pythonPath, ['-c', PYTHON_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8'
        }
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', error => {
        reject(new Error(`Argos Translate could not start: ${error.message}`));
      });

      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`Argos Translate failed with exit code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`Argos Translate returned invalid JSON: ${stdout || stderr}`));
        }
      });

      child.stdin.write(input, 'utf8');
      child.stdin.end();
    });
  }

  private resolvePythonPath(configuredPythonPath: string | undefined): string {
    const candidate = configuredPythonPath?.trim() || this.getDefaultPythonPath();
    if (!fs.existsSync(candidate)) {
      throw new Error(`Argos Python environment was not found: ${candidate}`);
    }

    return candidate;
  }

  private normalizeLanguageCode(language: string): string {
    return (language || '').split(/[-_]/)[0].toLowerCase();
  }

  private extractSubtitleTextSegments(content: string): { texts: string[]; rebuild: (translations: string[]) => string } {
    const normalized = content.replace(/\r\n/g, '\n');
    const blocks = normalized.split(/\n{2,}/);
    const texts: string[] = [];
    const blockParts = blocks.map(block => {
      const lines = block.split('\n');
      const textIndexes: number[] = [];
      const textLines: string[] = [];

      lines.forEach((line, index) => {
        if (this.isTranslatableSubtitleLine(line, index)) {
          textIndexes.push(index);
          textLines.push(line);
        }
      });

      const segmentIndex = textLines.length > 0 ? texts.push(textLines.join('\n')) - 1 : -1;
      return { lines, textIndexes, segmentIndex };
    });

    return {
      texts,
      rebuild: (translations: string[]) => blockParts.map(part => {
        if (part.segmentIndex < 0) {
          return part.lines.join('\n');
        }

        const translatedLines = String(translations[part.segmentIndex] || '').split('\n');
        const rebuilt = [...part.lines];
        part.textIndexes.forEach((lineIndex, offset) => {
          rebuilt[lineIndex] = translatedLines[offset] || translatedLines.join(' ');
        });
        return rebuilt.join('\n');
      }).join('\n\n')
    };
  }

  private isTranslatableSubtitleLine(line: string, indexInBlock: number): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (indexInBlock === 0 && /^(WEBVTT|NOTE|STYLE|REGION)$/i.test(trimmed)) return false;
    if (/^\d+$/.test(trimmed)) return false;
    if (/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(trimmed)) return false;
    if (/^(\{\\|WEBVTT|NOTE|STYLE|REGION)/i.test(trimmed)) return false;
    return true;
  }
}
