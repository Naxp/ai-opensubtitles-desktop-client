import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export type LocalTranscriptionEngine = 'whisper-cpp' | 'openai-whisper';

export interface WhisperConfig {
  engine?: LocalTranscriptionEngine;
  executablePath?: string;
  modelPath?: string;
  model?: string;
}

export interface WhisperTranscriptionOptions extends WhisperConfig {
  inputPath: string;
  language?: string;
}

export interface WhisperTranscriptionResult {
  content: string;
  fileName: string;
  engine: LocalTranscriptionEngine;
  model: string;
}

const DEFAULT_MODELS = ['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-medium', 'whisper-large-v3'];

export class WhisperManager {
  constructor(
    private readonly ffmpegPath: string | null,
    private readonly userDataPath: string
  ) {}

  getModelIds(config: WhisperConfig = {}): string[] {
    const configured = this.normalizeModelId(config.model || '');
    return configured ? [configured, ...DEFAULT_MODELS.filter(model => model !== configured)] : DEFAULT_MODELS;
  }

  async transcribe(options: WhisperTranscriptionOptions): Promise<WhisperTranscriptionResult> {
    if (!this.ffmpegPath) {
      throw new Error('FFmpeg is required for local Whisper transcription but is not ready.');
    }

    if (!fs.existsSync(options.inputPath)) {
      throw new Error(`Input media file was not found: ${options.inputPath}`);
    }

    const engine = options.engine || 'whisper-cpp';
    const model = this.normalizeModelName(options.model || 'base');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-os-whisper-'));
    const wavPath = path.join(workDir, 'input.wav');

    try {
      await this.convertToWav16k(options.inputPath, wavPath);

      if (engine === 'openai-whisper') {
        return await this.runOpenAIWhisper({
          ...options,
          inputPath: wavPath,
          model,
          engine
        }, workDir);
      }

      return await this.runWhisperCpp({
        ...options,
        inputPath: wavPath,
        model,
        engine
      }, workDir);
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private async convertToWav16k(inputPath: string, outputPath: string): Promise<void> {
    await this.runProcess(this.ffmpegPath!, [
      '-y',
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outputPath
    ], 'FFmpeg audio conversion');
  }

  private async runWhisperCpp(options: Required<Pick<WhisperTranscriptionOptions, 'inputPath' | 'engine' | 'model'>> & WhisperTranscriptionOptions, workDir: string): Promise<WhisperTranscriptionResult> {
    const executable = this.resolveExecutable(
      options.executablePath,
      [
        path.join(this.userDataPath, 'whisper.cpp', 'build', 'bin', 'Release', this.platformExe('whisper-cli')),
        path.join(this.userDataPath, 'whisper.cpp', 'build', 'bin', this.platformExe('whisper-cli')),
        path.join(process.cwd(), 'whisper.cpp', 'build', 'bin', 'Release', this.platformExe('whisper-cli')),
        path.join(process.cwd(), 'whisper.cpp', 'build', 'bin', this.platformExe('whisper-cli')),
        'whisper-cli'
      ]
    );
    const modelPath = this.resolveModelPath(options.modelPath, options.model);
    const outputBase = path.join(workDir, 'transcription');
    const args = [
      '-m',
      modelPath,
      '-f',
      options.inputPath,
      '-l',
      this.normalizeLanguage(options.language),
      '-osrt',
      '-of',
      outputBase
    ];

    await this.runProcess(executable, args, 'whisper.cpp transcription');

    const srtPath = `${outputBase}.srt`;
    if (!fs.existsSync(srtPath)) {
      throw new Error('whisper.cpp completed but did not produce an SRT file.');
    }

    return {
      content: fs.readFileSync(srtPath, 'utf8'),
      fileName: path.basename(srtPath),
      engine: options.engine,
      model: options.model
    };
  }

  private async runOpenAIWhisper(options: Required<Pick<WhisperTranscriptionOptions, 'inputPath' | 'engine' | 'model'>> & WhisperTranscriptionOptions, workDir: string): Promise<WhisperTranscriptionResult> {
    const executable = this.resolveExecutable(options.executablePath, ['whisper']);
    const args = [
      options.inputPath,
      '--model',
      options.model,
      '--output_format',
      'srt',
      '--output_dir',
      workDir,
      '--fp16',
      'False'
    ];

    const language = this.normalizeLanguage(options.language);
    if (language !== 'auto') {
      args.push('--language', language);
    }

    await this.runProcess(executable, args, 'OpenAI Whisper transcription');

    const srtPath = path.join(workDir, `${path.parse(options.inputPath).name}.srt`);
    if (!fs.existsSync(srtPath)) {
      throw new Error('OpenAI Whisper completed but did not produce an SRT file.');
    }

    return {
      content: fs.readFileSync(srtPath, 'utf8'),
      fileName: path.basename(srtPath),
      engine: options.engine,
      model: options.model
    };
  }

  private resolveExecutable(configuredPath: string | undefined, candidates: string[]): string {
    const trimmed = configuredPath?.trim();
    if (trimmed) {
      if (fs.existsSync(trimmed) || !trimmed.includes(path.sep)) {
        return trimmed;
      }
      throw new Error(`Configured Whisper executable was not found: ${trimmed}`);
    }

    for (const candidate of candidates) {
      if (!candidate.includes(path.sep) || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error('No local Whisper executable was found. Configure a whisper.cpp whisper-cli path or install the OpenAI Whisper CLI locally.');
  }

  private resolveModelPath(configuredPath: string | undefined, model: string): string {
    const trimmed = configuredPath?.trim();
    if (trimmed) {
      if (fs.existsSync(trimmed)) {
        return trimmed;
      }
      throw new Error(`Configured Whisper model file was not found: ${trimmed}`);
    }

    const fileName = model.endsWith('.bin') ? model : `ggml-${model}.bin`;
    const candidates = [
      path.join(this.userDataPath, 'whisper.cpp', 'models', fileName),
      path.join(process.cwd(), 'whisper.cpp', 'models', fileName),
      path.join(process.cwd(), 'models', fileName)
    ];

    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) {
      return found;
    }

    throw new Error(`No local whisper.cpp model file was found for "${model}". Configure a GGML model path in Preferences.`);
  }

  private async runProcess(command: string, args: string[], label: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const needsWindowsCommandWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
      const spawnCommand = needsWindowsCommandWrapper
        ? [command, ...args].map(this.quoteWindowsCommandArg).join(' ')
        : command;
      const spawnArgs = needsWindowsCommandWrapper ? [] : args;
      const child = spawn(spawnCommand, spawnArgs, {
        shell: needsWindowsCommandWrapper,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', error => {
        reject(new Error(`${label} could not start: ${error.message}`));
      });

      child.on('close', code => {
        if (code === 0) {
          resolve();
          return;
        }

        const details = (stderr || stdout || '').trim();
        reject(new Error(`${label} failed with exit code ${code}${details ? `: ${details}` : ''}`));
      });
    });
  }

  private normalizeModelId(model: string): string {
    const normalized = this.normalizeModelName(model);
    return normalized ? `whisper-${normalized}` : '';
  }

  private normalizeModelName(model: string): string {
    return model.replace(/^whisper-/, '').trim();
  }

  private normalizeLanguage(language?: string): string {
    if (!language || language === 'auto') {
      return 'auto';
    }

    return language.split(/[-_]/)[0].toLowerCase();
  }

  private platformExe(name: string): string {
    return process.platform === 'win32' ? `${name}.exe` : name;
  }

  private quoteWindowsCommandArg(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
