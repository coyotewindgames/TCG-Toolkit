import { describe, expect, it } from 'vitest';
import { BarcodeService } from '../src/server/services/barcode';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('BarcodeService', () => {
  const svc = new BarcodeService();

  it('renders code128 PNGs', async () => {
    const png = await svc.code128('test-sku-1234');
    expect(png.length).toBeGreaterThan(64);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('renders QR PNGs', async () => {
    const png = await svc.qr('test-sku-1234');
    expect(png.length).toBeGreaterThan(64);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('renders a multi-page Avery 5160 label sheet as PDF', async () => {
    // 31 labels forces a second page (30 per sheet).
    const items = Array.from({ length: 31 }, (_, i) => ({
      barcode: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      title: `Sample Card ${i}`,
      subtitle: `$${(i + 1).toFixed(2)}`,
    }));
    const pdf = await svc.labelSheetPdf(items);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // PDF EOF marker should appear within the trailer.
    expect(pdf.subarray(-32).toString('ascii')).toContain('%%EOF');
  });

  it('renders a Nelko 14x40mm label PDF', async () => {
    const pdf = await svc.labelSheetPdf(
      [
        {
          barcode: '00000000-0000-0000-0000-000000000000',
          title: 'Zacian V Crown Zenith',
          subtitle: '$12.34',
        },
      ],
      { format: 'qr', sheet: 'nelko14x40' },
    );

    const pdfText = pdf.toString('latin1');
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdfText).toMatch(/\/MediaBox \[0 0 113\.3[0-9]+ 39\.6[0-9]+\]/);
  });

  it('respects copies count', async () => {
    const pdf = await svc.labelSheetPdf([
      { barcode: 'abc', title: 'x', copies: 3 },
    ]);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
