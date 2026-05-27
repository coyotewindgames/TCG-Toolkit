import bwipjs from 'bwip-js';

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
}
