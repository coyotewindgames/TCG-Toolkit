import { Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';

/** Generate label PNGs from barcode payloads. */
@Injectable()
export class BarcodeService {
  /** Code128 PNG for thermal labels. */
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

  /** QR PNG for trade-in receipts or rich payloads. */
  async qr(text: string): Promise<Buffer> {
    return bwipjs.toBuffer({
      bcid: 'qrcode',
      text,
      scale: 5,
    });
  }
}
