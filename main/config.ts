import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_API_KEY = '5MGRBWO9lHA023KPmVMaa0PoRYHqQKpK';

export interface AppConfig {
  username: string;
  password: string;
  apiKey?: string;
  lastUsedLanguage?: string;
  debugMode?: boolean;
  debugLevel?: number;
  checkUpdatesOnStart?: boolean;
  autoRemoveCompletedFiles?: boolean;
  cacheExpirationHours?: number;
  betaTest?: boolean;
  ffmpegPath?: string;
  apiBaseUrl?: string;
  aiProvider?: 'ollama' | 'lmstudio' | 'argos';
  ollamaBaseUrl?: string;
  lmStudioBaseUrl?: string;
  lmStudioApiKey?: string;
  argosPythonPath?: string;
  localTranscriptionEngine?: 'whisper-cpp' | 'openai-whisper';
  whisperExecutablePath?: string;
  whisperModelPath?: string;
  whisperModel?: string;
  userId?: number;
  autoLanguageDetection?: boolean;
  credits?: {
    used: number;
    remaining: number;
  };
}

export class ConfigManager {
  private configPath: string;
  private config: AppConfig;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'config.json');
    this.config = this.loadConfig();
  }

  private debug(level: number, category: string, message: string, ...args: any[]) {
    const debugLevel = this.config.debugLevel ?? 0;

    if (debugLevel >= level) {
      console.log(`[${category}] ${message}`, ...args);
    }
  }

  private createDefaultConfig(): AppConfig {
    return {
      username: '',
      password: '',
      apiKey: DEFAULT_API_KEY,
      debugMode: false,
      checkUpdatesOnStart: false,
      autoRemoveCompletedFiles: false,
      cacheExpirationHours: 24,
      betaTest: false,
      ffmpegPath: '',
      apiBaseUrl: 'https://api.opensubtitles.com/api/v1',
      aiProvider: 'ollama',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      lmStudioBaseUrl: 'http://127.0.0.1:1234/v1',
      lmStudioApiKey: '',
      argosPythonPath: '',
      localTranscriptionEngine: 'whisper-cpp',
      whisperExecutablePath: '',
      whisperModelPath: '',
      whisperModel: 'base',
      autoLanguageDetection: false,
    };
  }

  private ensureUserDataDirectory(): string {
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    }
    return userDataPath;
  }

  private hardenPrivateFile(filePath: string): void {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows ACLs and some filesystems do not expose POSIX modes.
    }
  }

  private writePrivateTextFileAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
      this.hardenPrivateFile(tempPath);
      fs.renameSync(tempPath, filePath);
      this.hardenPrivateFile(filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        this.hardenPrivateFile(this.configPath);
        const data = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...this.createDefaultConfig(), ...parsed };
        }
        throw new Error('Config root must be a JSON object');
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }

    return this.createDefaultConfig();
  }

  getConfig(): AppConfig {
    return { ...this.config };
  }

  saveConfig(newConfig: Partial<AppConfig>): boolean {
    const nextConfig = { ...this.config, ...newConfig };
    try {
      this.ensureUserDataDirectory();
      this.writePrivateTextFileAtomic(this.configPath, JSON.stringify(nextConfig, null, 2));
      this.config = nextConfig;
      return true;
    } catch (error) {
      console.error('Error saving config:', error);
      return false;
    }
  }

  updateCredits(used: number, remaining: number): void {
    this.saveConfig({ credits: { used, remaining } });
  }

  isConfigured(): boolean {
    return !!(this.config.username && this.config.password && this.config.apiKey);
  }

  // Token management - separate from user config
  private getTokenPath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'auth_token.txt');
  }

  saveToken(token: string): boolean {
    try {
      this.ensureUserDataDirectory();
      this.writePrivateTextFileAtomic(this.getTokenPath(), token);
      return true;
    } catch (error) {
      console.error('Error saving token:', error);
      return false;
    }
  }

  getValidToken(): string | null {
    try {
      const tokenPath = this.getTokenPath();

      if (!fs.existsSync(tokenPath)) {
        return null;
      }

      this.hardenPrivateFile(tokenPath);

      // Check if token file is less than 6 hours old
      const stats = fs.statSync(tokenPath);
      const fileAge = Date.now() - stats.mtime.getTime();
      const sixHours = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

      if (fileAge > sixHours) {
        // Token is too old, delete it
        fs.unlinkSync(tokenPath);
        return null;
      }

      // Token is valid, return it
      return fs.readFileSync(tokenPath, 'utf8');
    } catch (error) {
      console.error('Error reading token:', error);
      return null;
    }
  }

  isTokenExpiredForHibernation(): boolean {
    try {
      const tokenPath = this.getTokenPath();

      if (!fs.existsSync(tokenPath)) {
        return true; // No token means expired
      }

      // Check if token file is older than 6 hours
      const stats = fs.statSync(tokenPath);
      const fileAge = Date.now() - stats.mtime.getTime();
      const sixHours = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

      return fileAge > sixHours;
    } catch (error) {
      console.error('Error checking token age:', error);
      return true; // Assume expired on error
    }
  }

  clearToken(): void {
    try {
      const tokenPath = this.getTokenPath();
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
      }
    } catch (error) {
      console.error('Error clearing token:', error);
    }
  }

  resetAllSettings(): boolean {
    try {
      this.debug(3, 'Config', '=== RESET SETTINGS DEBUG ===');
      this.debug(3, 'Config', 'Config path:', this.configPath);
      this.debug(3, 'Config', 'Config file exists:', fs.existsSync(this.configPath));

      // Clear config file
      if (fs.existsSync(this.configPath)) {
        this.debug(2, 'Config', 'Deleting config file...');
        fs.unlinkSync(this.configPath);
        this.debug(2, 'Config', 'Config file deleted successfully');
      }

      // Clear token file
      this.debug(2, 'Config', 'Clearing token...');
      this.clearToken();
      this.debug(2, 'Config', 'Token cleared successfully');

      // Reset in-memory config to defaults
      this.debug(2, 'Config', 'Resetting in-memory config...');
      this.config = this.createDefaultConfig();
      this.debug(2, 'Config', 'In-memory config reset successfully');

      this.debug(2, 'Config', 'All settings have been reset successfully');
      this.debug(3, 'Config', '=== END RESET SETTINGS DEBUG ===');
      return true;
    } catch (error) {
      console.error('=== RESET SETTINGS ERROR ===');
      console.error('Error resetting settings:', error);
      console.error('Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      });
      console.error('=== END RESET SETTINGS ERROR ===');
      return false;
    }
  }
}
