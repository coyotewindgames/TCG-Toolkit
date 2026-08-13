import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { NotFound } from '../../common/http-errors';

export interface BillOfSaleLineItem {
  productName: string;
  setName: string | null;
  cardNumber: string | null;
  condition: string | null;
  printing: string;
  language: string;
  gradingCompany: string | null;
  grade: string | null;
  quantity: number;
  unitValueCents: number;
}

export interface BillOfSaleData {
  tradeId: string;
  barcode: string | null;
  payout: 'cash' | 'store_credit';
  totalValueCents: number;
  completedAt: Date;
  storeName: string;
  locationName: string;
  locationAddress: { street?: string; city?: string; state?: string; zip?: string } | null;
  customerName: string | null;
  items: BillOfSaleLineItem[];
}

const PAGE_MARGIN = 50;
const DISCLAIMER =
  'Item(s) listed above were purchased by the store as-is, based on the condition represented ' +
  'by the seller at time of sale. All sales are final: no returns, exchanges, or refunds once ' +
  'payout has been issued. By signing below, the seller affirms lawful ownership of the item(s) ' +
  'and the right to sell or trade them.';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function itemDetail(item: BillOfSaleLineItem): string {
  const parts: string[] = [];
  if (item.gradingCompany && item.grade) {
    parts.push(`${item.gradingCompany} ${item.grade}`);
  } else if (item.condition) {
    parts.push(item.condition);
  }
  parts.push(item.printing);
  if (item.language && item.language !== 'EN') parts.push(item.language);
  return parts.join(' · ');
}

function formatAddress(addr: BillOfSaleData['locationAddress']): string | null {
  if (!addr) return null;
  const line = [addr.street, [addr.city, addr.state].filter(Boolean).join(', '), addr.zip]
    .filter(Boolean)
    .join(', ');
  return line || null;
}

/**
 * Pure PDF renderer, split out from the DB-fetching service method so it can
 * be unit tested without a live database (mirrors `computeSuggestedUnitValueCents`
 * in tradeins.ts).
 */
export function renderTradeInBillOfSalePdf(data: BillOfSaleData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;

  // ---- Header ----
  doc.font('Helvetica-Bold').fontSize(18).text(data.storeName, PAGE_MARGIN, PAGE_MARGIN);
  doc.font('Helvetica').fontSize(10).fillColor('#555').text('Bill of Sale', PAGE_MARGIN, doc.y);
  const locationAddress = formatAddress(data.locationAddress);
  doc.text(locationAddress ? `${data.locationName} — ${locationAddress}` : data.locationName);
  doc.fillColor('#000');

  const headerRightX = PAGE_MARGIN + pageWidth / 2;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555')
    .text(`Date: ${data.completedAt.toLocaleDateString()}`, headerRightX, PAGE_MARGIN, {
      width: pageWidth / 2,
      align: 'right',
    })
    .text(`Doc #: ${data.tradeId.slice(0, 8).toUpperCase()}`, {
      width: pageWidth / 2,
      align: 'right',
    });
  if (data.barcode) {
    doc.text(`Ref: ${data.barcode}`, { width: pageWidth / 2, align: 'right' });
  }
  doc.fillColor('#000');

  doc.moveDown(1.5);
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(data.payout === 'cash' ? 'Transaction type: Cash Purchase' : 'Transaction type: Trade-In / Store Credit');
  doc.moveDown(1);

  // ---- Parties ----
  const partyTop = doc.y;
  const colWidth = pageWidth / 2 - 10;
  doc.font('Helvetica-Bold').fontSize(10).text('Seller', PAGE_MARGIN, partyTop, { width: colWidth });
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(data.customerName ?? '_______________________________', PAGE_MARGIN, doc.y, { width: colWidth });

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('Buyer', headerRightX, partyTop, { width: colWidth });
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(data.storeName, headerRightX, doc.y, { width: colWidth });
  if (locationAddress) doc.text(locationAddress, headerRightX, doc.y, { width: colWidth });

  doc.y = Math.max(doc.y, partyTop + 40);
  doc.moveDown(1);

  // ---- Line items table ----
  const colQty = PAGE_MARGIN;
  const colItem = PAGE_MARGIN + 40;
  const colDetail = PAGE_MARGIN + 230;
  const colUnit = PAGE_MARGIN + 380;
  const colLine = PAGE_MARGIN + 450;

  function drawTableHeader(): void {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555');
    const y = doc.y;
    doc.text('Qty', colQty, y, { width: 35 });
    doc.text('Card', colItem, y, { width: colDetail - colItem - 10 });
    doc.text('Details', colDetail, y, { width: colUnit - colDetail - 10 });
    doc.text('Unit', colUnit, y, { width: colLine - colUnit - 10, align: 'right' });
    doc.text('Total', colLine, y, { width: PAGE_MARGIN + pageWidth - colLine, align: 'right' });
    doc.fillColor('#000');
    doc.moveDown(0.5);
    doc
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + pageWidth, doc.y)
      .strokeColor('#ccc')
      .stroke();
    doc.moveDown(0.5);
  }

  drawTableHeader();
  doc.font('Helvetica').fontSize(9);
  for (const item of data.items) {
    if (doc.y > doc.page.height - PAGE_MARGIN - 150) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
      drawTableHeader();
      doc.font('Helvetica').fontSize(9);
    }
    const rowTop = doc.y;
    const cardLabel = [item.productName, item.setName, item.cardNumber ? `#${item.cardNumber}` : null]
      .filter(Boolean)
      .join(' — ');
    doc.text(String(item.quantity), colQty, rowTop, { width: 35 });
    doc.text(cardLabel, colItem, rowTop, { width: colDetail - colItem - 10 });
    doc.text(itemDetail(item), colDetail, rowTop, { width: colUnit - colDetail - 10 });
    doc.text(money(item.unitValueCents), colUnit, rowTop, {
      width: colLine - colUnit - 10,
      align: 'right',
    });
    doc.text(money(item.unitValueCents * item.quantity), colLine, rowTop, {
      width: PAGE_MARGIN + pageWidth - colLine,
      align: 'right',
    });
    doc.y = Math.max(doc.y, rowTop + 14);
    doc.moveDown(0.3);
  }

  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + pageWidth, doc.y)
    .strokeColor('#ccc')
    .stroke();
  doc.moveDown(0.5);

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(
      `Total (${data.payout === 'cash' ? 'cash paid' : 'store credit issued'}): ${money(data.totalValueCents)}`,
      PAGE_MARGIN,
      doc.y,
      { width: pageWidth, align: 'right' },
    );

  // ---- Disclaimer ----
  if (doc.y > doc.page.height - PAGE_MARGIN - 160) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  } else {
    doc.moveDown(1.5);
  }
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#555')
    .text(DISCLAIMER, PAGE_MARGIN, doc.y, { width: pageWidth });
  doc.fillColor('#000');

  // ---- Signatures ----
  doc.moveDown(3);
  const sigY = doc.y;
  doc
    .moveTo(PAGE_MARGIN, sigY)
    .lineTo(PAGE_MARGIN + colWidth, sigY)
    .strokeColor('#000')
    .stroke();
  doc.fontSize(9).text('Seller signature / printed name / date', PAGE_MARGIN, sigY + 4, { width: colWidth });

  doc
    .moveTo(headerRightX, sigY)
    .lineTo(headerRightX + colWidth, sigY)
    .strokeColor('#000')
    .stroke();
  doc.text('Store representative / date', headerRightX, sigY + 4, { width: colWidth });

  doc
    .fontSize(7)
    .fillColor('#999')
    .text(
      `Generated ${new Date().toLocaleString()} · Trade ${data.tradeId}`,
      PAGE_MARGIN,
      doc.page.height - PAGE_MARGIN - 20,
      { width: pageWidth, align: 'center' },
    );

  doc.end();
  return finished;
}

export class BillOfSaleService {
  constructor(private readonly db: Database) {}

  async tradeInPdf(args: { storeId: string; tradeId: string }): Promise<Buffer> {
    const [trade] = await this.db
      .select()
      .from(schema.tradeIns)
      .where(eq(schema.tradeIns.id, args.tradeId));
    if (!trade || trade.storeId !== args.storeId) throw NotFound('trade not found');

    const [store] = await this.db.select().from(schema.stores).where(eq(schema.stores.id, args.storeId));
    if (!store) throw NotFound('store not found');

    const [location] = await this.db
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.id, trade.locationId));

    const customer = trade.customerId
      ? (
          await this.db.select().from(schema.customers).where(eq(schema.customers.id, trade.customerId))
        )[0]
      : undefined;

    const rows = await this.db
      .select({
        quantity: schema.tradeItems.quantity,
        unitValueCents: schema.tradeItems.unitValueCents,
        productName: schema.products.name,
        setName: schema.products.setName,
        cardNumber: schema.products.cardNumber,
        condition: schema.skus.condition,
        printing: schema.skus.printing,
        language: schema.skus.language,
        gradingCompany: schema.skus.gradingCompany,
        grade: schema.skus.grade,
      })
      .from(schema.tradeItems)
      .innerJoin(schema.skus, eq(schema.skus.id, schema.tradeItems.skuId))
      .innerJoin(schema.products, eq(schema.products.id, schema.skus.productId))
      .where(eq(schema.tradeItems.tradeId, trade.id));

    return renderTradeInBillOfSalePdf({
      tradeId: trade.id,
      barcode: trade.barcode,
      payout: trade.payout,
      totalValueCents: trade.totalValueCents,
      completedAt: trade.completedAt ?? trade.createdAt,
      storeName: store.name,
      locationName: location?.name ?? 'Store location',
      locationAddress: (location?.address as BillOfSaleData['locationAddress']) ?? null,
      customerName: customer?.name ?? null,
      items: rows.map((row) => ({
        productName: row.productName,
        setName: row.setName,
        cardNumber: row.cardNumber,
        condition: row.condition,
        printing: row.printing,
        language: row.language,
        gradingCompany: row.gradingCompany,
        grade: row.grade,
        quantity: row.quantity,
        unitValueCents: row.unitValueCents,
      })),
    });
  }
}
