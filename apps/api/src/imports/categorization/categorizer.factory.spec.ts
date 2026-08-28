import { BadRequestException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CategorizerFactory } from './categorizer.factory';

/** ConfigService reads one key at a time, so a plain map is enough. */
const factoryWith = (env: Record<string, string>) =>
  new CategorizerFactory({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

describe('CategorizerFactory', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the server default', () => {
    it('honours an explicit CATEGORIZER even when a key is present', () => {
      // The bug this guards: for a month the deployment set CATEGORIZER=ollama,
      // compose dropped the variable, and the blank value resolved back to
      // Anthropic because a key happened to be set. Every import ran hosted.
      const f = factoryWith({
        CATEGORIZER: 'ollama',
        ANTHROPIC_API_KEY: 'sk-test',
      });
      expect(f.defaultId).toBe('ollama');
      expect(f.create().name).toBe('ollama');
    });

    it('infers Anthropic from a key when CATEGORIZER is unset', () => {
      expect(factoryWith({ ANTHROPIC_API_KEY: 'sk-test' }).defaultId).toBe(
        'anthropic',
      );
    });

    it('infers the heuristic with neither set', () => {
      expect(factoryWith({}).defaultId).toBe('heuristic');
    });

    // Compose passes these as ${CATEGORIZER:-}, so "unset" arrives as "".
    it('treats a blank CATEGORIZER as unset, not as a provider name', () => {
      expect(factoryWith({ CATEGORIZER: '   ' }).defaultId).toBe('heuristic');
    });

    it('says so out loud when the choice was inferred', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      factoryWith({ ANTHROPIC_API_KEY: 'sk-test' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('CATEGORIZER is not set'),
      );
    });

    it('falls back to safe on a value it does not recognize', () => {
      const f = factoryWith({ CATEGORIZER: 'gpt4' });
      expect(f.defaultId).toBe('heuristic');
    });
  });

  describe('per-import choice', () => {
    it('overrides the default', () => {
      const f = factoryWith({
        CATEGORIZER: 'heuristic',
        ANTHROPIC_API_KEY: 'sk-test',
      });
      expect(f.create('anthropic').name).toBe('anthropic');
      expect(f.create('ollama').name).toBe('ollama');
    });

    it('falls back to the default when nothing is named', () => {
      const f = factoryWith({ CATEGORIZER: 'ollama' });
      expect(f.create().name).toBe('ollama');
      expect(f.create(null).name).toBe('ollama');
      expect(f.create('').name).toBe('ollama');
    });

    it('refuses Claude when this server has no key', () => {
      expect(() => factoryWith({}).create('anthropic')).toThrow(
        BadRequestException,
      );
    });

    it('carries the configured model onto the provider it builds', () => {
      const f = factoryWith({
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
        OLLAMA_MODEL: 'qwen2.5:7b',
      });
      expect(f.create('anthropic').modelName).toBe('claude-haiku-4-5-20251001');
      expect(f.create('ollama').modelName).toBe('qwen2.5:7b');
    });
  });

  describe('options', () => {
    it('marks Claude unavailable without a key, and never as the default', () => {
      const claude = factoryWith({})
        .options()
        .find((o) => o.id === 'anthropic');
      expect(claude).toMatchObject({ available: false, isDefault: false });
    });

    it('flags exactly the provider that sends data off the server', () => {
      const off = factoryWith({ ANTHROPIC_API_KEY: 'sk-test' })
        .options()
        .filter((o) => o.sendsDataOffServer)
        .map((o) => o.id);
      expect(off).toEqual(['anthropic']);
    });

    it('marks one default, and only one', () => {
      const defaults = factoryWith({ CATEGORIZER: 'ollama' })
        .options()
        .filter((o) => o.isDefault);
      expect(defaults.map((o) => o.id)).toEqual(['ollama']);
    });
  });
});
