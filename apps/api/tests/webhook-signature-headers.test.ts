import { describe, it, expect } from 'vitest';
import { CloverClient } from '../src/integrations/pos/clover';
import { createHmac } from 'node:crypto';

describe('CloverClient.verifyWebhookSignature header variants', () => {
  const secret = 'top_secret_signing_key_123456';
  const body = JSON.stringify({ type: 'PAYMENTS_CREATED', externalReferenceId: 'order-1' });
  const digest = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a bare hex digest', () => {
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: body,
        signatureHeader: digest,
        signingSecret: secret,
      }),
    ).toBe(true);
  });

  it('accepts an "sha256=<hex>" prefixed header', () => {
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: body,
        signatureHeader: `sha256=${digest}`,
        signingSecret: secret,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: body + 'x',
        signatureHeader: digest,
        signingSecret: secret,
      }),
    ).toBe(false);
  });
});
