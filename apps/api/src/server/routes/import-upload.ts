/**
 * Turns an uploaded inventory file into CSV text. Spreadsheets are converted
 * sheet-1-only; anything binary is rejected before it reaches the importer.
 */
import * as XLSX from 'xlsx';
import type { Logger } from 'pino';
import { BadRequest } from '../../common/http-errors';

function hasZipSignature(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function hasNulByte(buf: Buffer): boolean {
  const sample = Math.min(buf.length, 2048);
  for (let i = 0; i < sample; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

export function parseImportUpload(file: Express.Multer.File, log: Logger): string {
  const originalName = (file.originalname ?? '').toLowerCase();
  const mime = (file.mimetype ?? '').toLowerCase();

  const isSpreadsheet =
    originalName.endsWith('.xlsx') ||
    originalName.endsWith('.xls') ||
    originalName.endsWith('.xlsm') ||
    mime.includes('spreadsheetml') ||
    mime === 'application/vnd.ms-excel' ||
    hasZipSignature(file.buffer);

  if (isSpreadsheet) {
    try {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;

      if (!firstSheet) {
        throw BadRequest('Spreadsheet file does not contain any sheets.');
      }

      const csvText = XLSX.utils.sheet_to_csv(firstSheet, { blankrows: false });
      log.debug(
        { filename: file.originalname, sheetName: firstSheetName, textLength: csvText.length },
        'spreadsheet upload converted to csv',
      );
      return csvText;
    } catch (err) {
      if (err instanceof Error && err.message === 'Spreadsheet file does not contain any sheets.') {
        throw err;
      }

      log.warn(
        { filename: file.originalname, mimetype: file.mimetype, err },
        'spreadsheet upload could not be parsed',
      );
      throw BadRequest('Unsupported spreadsheet file. Please upload a valid CSV, XLSX, or XLS file.');
    }
  }

  if (hasNulByte(file.buffer)) {
    log.warn(
      { filename: file.originalname, mimetype: file.mimetype },
      'rejected binary upload (null bytes)',
    );
    throw BadRequest('Unsupported file type. Only plain CSV text files are accepted.');
  }

  return file.buffer.toString('utf8');
}
