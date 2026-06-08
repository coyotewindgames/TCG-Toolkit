import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

export interface LabelItem {
  /** Text encoded in the barcode (typically the SKU id / barcode token). */
  barcode: string;
  /** Display title above the barcode (e.g., product name). */
  title?: string;
  /** Optional secondary text below the barcode (price, condition, etc.). */
  subtitle?: string;
  /** How many copies of this label to print. Defaults to 1. */
  copies?: number;
}

const POINTS_PER_INCH = 72;

// Avery 5160: US Letter (8.5" × 11"), 3 cols × 10 rows = 30 labels/page.
// Label is 2.625" wide × 1" tall. Top/left margin 0.5", horizontal gutter 0.125".
const SHEET = {
  pageWidth: 8.5 * POINTS_PER_INCH,
  pageHeight: 11 * POINTS_PER_INCH,
  marginTop: 0.5 * POINTS_PER_INCH,
  marginLeft: 0.1875 * POINTS_PER_INCH,
  labelWidth: 2.625 * POINTS_PER_INCH,
  labelHeight: 1.0 * POINTS_PER_INCH,
  hGutter: 0.125 * POINTS_PER_INCH,
  vGutter: 0,
  cols: 3,
  rows: 10,
} as const;

export class BarcodeService {
  async code128(text: string): Promise<Buffer> {
    return bwipjs.toBuffer({
      bcid: 'code128',
      text,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center',
    });
  }

  async qr(text: string): Promise<Buffer> {
    return bwipjs.toBuffer({
      bcid: 'qrcode',
      text,
      scale: 5,
    });
  }

  /**
   * Render an Avery 5160-style sheet of labels as a single PDF. Each item is
   * laid out left-to-right, top-to-bottom; sheets break automatically.
   *
   * `format` controls what's drawn on each label:
   *   - 'code128' (default): wide barcode across the label, title above,
   *     subtitle below.
   *   - 'qr': square QR pinned to the left side of the label, title and
   *     subtitle stacked on the right. Suited for sticking onto card
   *     sleeves where a phone needs to scan it.
   */
  async labelSheetPdf(
    items: LabelItem[],
    opts: { format?: 'code128' | 'qr' } = {},
  ): Promise<Buffer> {
    const format = opts.format ?? 'code128';
    const doc = new PDFDocument({
      size: [SHEET.pageWidth, SHEET.pageHeight],
      margin: 0,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const finished = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    let slot = 0;
    for (const item of items) {
      const copies = Math.max(1, item.copies ?? 1);
      for (let i = 0; i < copies; i++) {
        if (slot > 0 && slot % (SHEET.cols * SHEET.rows) === 0) {
          doc.addPage({ size: [SHEET.pageWidth, SHEET.pageHeight], margin: 0 });
        }
        const indexOnPage = slot % (SHEET.cols * SHEET.rows);
        const col = indexOnPage % SHEET.cols;
        const row = Math.floor(indexOnPage / SHEET.cols);
        const x = SHEET.marginLeft + col * (SHEET.labelWidth + SHEET.hGutter);
        const y = SHEET.marginTop + row * (SHEET.labelHeight + SHEET.vGutter);

        if (format === 'qr') {
          await this.drawQrLabel(doc, item, x, y);
        } else {
          await this.drawLabel(doc, item, x, y);
        }
        slot += 1;
      }
    }

    doc.end();
    return finished;
  }

  private async drawLabel(
    doc: PDFKit.PDFDocument,
    item: LabelItem,
    x: number,
    y: number,
  ): Promise<void> {
    const png = await bwipjs.toBuffer({
      bcid: 'code128',
      text: item.barcode,
      scale: 2,
      height: 8,
      includetext: false,
    });

    const pad = 4;
    const innerW = SHEET.labelWidth - pad * 2;

    if (item.title) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(item.title.slice(0, 40), x + pad, y + pad, {
          width: innerW,
          height: 10,
          ellipsis: true,
          lineBreak: false,
        });
    }

    const barcodeY = y + pad + (item.title ? 12 : 0);
    const barcodeH = SHEET.labelHeight - (barcodeY - y) - (item.subtitle ? 16 : pad);
    doc.image(png, x + pad, barcodeY, { width: innerW, height: barcodeH });

    if (item.subtitle) {
      doc
        .font('Helvetica')
        .fontSize(7)
        .text(item.subtitle, x + pad, y + SHEET.labelHeight - 12, {
          width: innerW,
          align: 'center',
          lineBreak: false,
        });
    }
  }

  /**
   * QR variant: square QR on the left, title/subtitle stacked on the right.
   * Designed for sticking onto sleeved cards where a clerk scans with a phone.
   */
  private async drawQrLabel(
    doc: PDFKit.PDFDocument,
    item: LabelItem,
    x: number,
    y: number,
  ): Promise<void> {
    const png = await bwipjs.toBuffer({
      bcid: 'qrcode',
      text: item.barcode,
      scale: 4,
    });

    const pad = 4;
    // Square QR sized to the label height minus padding.
    const qrSize = SHEET.labelHeight - pad * 2;
    doc.image(png, x + pad, y + pad, { width: qrSize, height: qrSize });

    const textX = x + pad + qrSize + pad;
    const textW = SHEET.labelWidth - (textX - x) - pad;

    if (item.title) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(item.title.slice(0, 60), textX, y + pad, {
          width: textW,
          height: 24,
          ellipsis: true,
        });
    }

    if (item.subtitle) {
      doc
        .font('Helvetica')
        .fontSize(7)
        .text(item.subtitle, textX, y + SHEET.labelHeight - pad - 9, {
          width: textW,
          lineBreak: false,
        });
    }
  }
}
