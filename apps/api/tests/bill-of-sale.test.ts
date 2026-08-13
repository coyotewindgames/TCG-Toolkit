import { describe, expect, it } from 'vitest';
import { renderTradeInBillOfSalePdf, type BillOfSaleData } from '../src/server/services/bill-of-sale';

function baseData(overrides: Partial<BillOfSaleData> = {}): BillOfSaleData {
  return {
    tradeId: '11111111-2222-3333-4444-555555555555',
    barcode: 'TRD-ABC123',
    payout: 'cash',
    totalValueCents: 1500,
    completedAt: new Date('2026-01-15T12:00:00Z'),
    storeName: 'SlowBros Cards',
    locationName: 'Main Store',
    locationAddress: { street: '123 Main St', city: 'Springfield', state: 'IL', zip: '62704' },
    customerName: 'Jane Doe',
    items: [
      {
        productName: 'Pikachu VMAX',
        setName: 'Vivid Voltage',
        cardNumber: '44/185',
        condition: 'NM',
        printing: 'Holofoil',
        language: 'EN',
        gradingCompany: null,
        grade: null,
        quantity: 1,
        unitValueCents: 1500,
      },
    ],
    ...overrides,
  };
}

describe('renderTradeInBillOfSalePdf', () => {
  it('renders a well-formed PDF for a single-item cash purchase', async () => {
    const pdf = await renderTradeInBillOfSalePdf(baseData());
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.subarray(-32).toString('ascii')).toContain('%%EOF');
  });

  it('handles a customer-less trade-in with a graded item and store credit payout', async () => {
    const pdf = await renderTradeInBillOfSalePdf(
      baseData({
        payout: 'store_credit',
        customerName: null,
        locationAddress: null,
        items: [
          {
            productName: 'Charizard',
            setName: 'Base Set',
            cardNumber: '4/102',
            condition: null,
            printing: 'Holofoil',
            language: 'EN',
            gradingCompany: 'PSA',
            grade: '9',
            quantity: 1,
            unitValueCents: 250_00,
          },
        ],
      }),
    );
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.subarray(-32).toString('ascii')).toContain('%%EOF');
  });

  it('paginates when a trade has many line items', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      productName: `Card ${i}`,
      setName: 'Some Set',
      cardNumber: String(i),
      condition: 'NM' as const,
      printing: 'Normal',
      language: 'EN',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      unitValueCents: 100,
    }));
    const pdf = await renderTradeInBillOfSalePdf(
      baseData({ items, totalValueCents: items.length * 100 }),
    );
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // A single-page doc for one item is well under this size; 60 rows forces
    // pdfkit to emit a second page object, which meaningfully increases size.
    expect(pdf.length).toBeGreaterThan(2000);
  });
});
