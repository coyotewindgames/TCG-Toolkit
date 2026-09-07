import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VisionCardIdentifier,
  VisionNotConfiguredError,
} from '../src/integrations/vision/client';

const IMAGE = 'data:image/jpeg;base64,AAAA';

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VisionCardIdentifier', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled without an API key and throws when used', async () => {
    const client = new VisionCardIdentifier({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(client.isEnabled()).toBe(false);
    await expect(client.identifyCard(IMAGE)).rejects.toBeInstanceOf(VisionNotConfiguredError);
  });

  it('parses a clean JSON identification', async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse(
        JSON.stringify({
          name: 'Charizard',
          setName: 'Base Set',
          number: '4/102',
          language: 'English',
          printingHint: 'Holo',
          confidence: 0.92,
        }),      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });

    const result = await client.identifyCard(IMAGE);
    expect(result).toEqual({
      name: 'Charizard',
      setName: 'Base Set',
      setCode: null,
      number: '4/102',
      language: 'English',
      printingHint: 'Holo',
      confidence: 0.92,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends legacy params (max_tokens + temperature 0) for gpt-4o models', async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ name: 'Pikachu', confidence: 0.9 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    });
    await client.identifyCard(IMAGE);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.max_tokens).toBe(400);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('sends gpt-5-compatible params (max_completion_tokens, no temperature)', async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse(JSON.stringify({ name: 'Pikachu', confidence: 0.9 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
    });
    await client.identifyCard(IMAGE);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.max_completion_tokens).toBe(1200);
    expect(body.max_tokens).toBeUndefined();
    // GPT-5 rejects a custom temperature, so we must not send one.
    expect(body.temperature).toBeUndefined();
  });

  it('extracts JSON even when the model wraps it in prose/fences', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        chatResponse('Here you go:\n```json\n{"name":"Pikachu","confidence":0.8}\n```'),
      ),
    );
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    const result = await client.identifyCard(IMAGE);
    expect(result?.name).toBe('Pikachu');
    expect(result?.setName).toBeNull();
  });

  it('returns null when the model reports no card (empty name / zero confidence)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chatResponse(JSON.stringify({ name: '', confidence: 0 }))),
    );
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(await client.identifyCard(IMAGE)).toBeNull();
  });

  it('returns null on unparseable content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chatResponse('I cannot help with that.')),
    );
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(await client.identifyCard(IMAGE)).toBeNull();
  });

  it('throws on an upstream error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const client = new VisionCardIdentifier({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    await expect(client.identifyCard(IMAGE)).rejects.toThrow(/vision provider error \(429\)/);
  });
});
