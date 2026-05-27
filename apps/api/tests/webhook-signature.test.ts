import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloverClient } from '../src/integrations/pos/clover';

const secret = 'whsec_test_signing_secret';

function sign(body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('CloverClient.verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ eventId: 'evt_1', type: 'PAYMENTS_CREATED' });
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body),
        signingSecret: secret,
      }),
    ).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const body = JSON.stringify({ eventId: 'evt_1', type: 'PAYMENTS_CREATED' });
    const tampered = JSON.stringify({ eventId: 'evt_1', type: 'PAYMENTS_REFUNDED' });
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: tampered,
        signatureHeader: sign(body),
        signingSecret: secret,
      }),
    ).toBe(false);
  });

  it('rejects when the secret differs', () => {
    const body = JSON.stringify({ eventId: 'evt_1' });
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body),
        signingSecret: 'other-secret',
      }),
    ).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(
      CloverClient.verifyWebhookSignature({
        rawBody: '{}',
        signatureHeader: '',
        signingSecret: secret,
      }),
    ).toBe(false);
  });
});
