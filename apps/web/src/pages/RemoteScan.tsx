import { FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';

type ScanRow = {
  code: string;
  ts: number;
};

export default function RemoteScanPage() {
  const [params] = useSearchParams();
  const orderId = params.get('orderId')?.trim() ?? '';
  const [barcode, setBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<ScanRow[]>([]);

  const canSubmit = orderId.length > 0 && barcode.trim().length > 0 && !busy;

  const title = useMemo(() => (orderId ? `Order ${orderId.slice(0, 8)}...` : 'Missing order id'), [orderId]);

  async function submitCode(code: string) {
    if (!orderId) {
      setMsg('Missing orderId in URL. Open this page from the Register scan link.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/orders/${orderId}/items`, { barcode: code });
      setHistory((prev) => [{ code, ts: Date.now() }, ...prev].slice(0, 8));
      setBarcode('');
      setMsg('Scanned and sent to register.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useBarcodeScanner((code) => {
    void submitCode(code);
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    await submitCode(barcode.trim());
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4">
      <div className="max-w-lg mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Remote Scanner</h1>
          <p className="text-sm text-slate-400">{title}</p>
          <p className="text-xs text-slate-500">
            Pair a Bluetooth scanner to this device or type a barcode manually.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm text-slate-300" htmlFor="barcode">
            Barcode
          </label>
          <input
            id="barcode"
            autoFocus
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="Scan or type barcode"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-emerald-500 text-slate-900 font-semibold py-2 disabled:bg-slate-700"
          >
            {busy ? 'Sending...' : 'Send Scan'}
          </button>
        </form>

        {msg && <p className="text-sm text-slate-300 break-all">{msg}</p>}

        <div className="pt-2 border-t border-slate-800">
          <h2 className="text-sm font-semibold mb-2">Recent scans</h2>
          {history.length === 0 ? (
            <p className="text-xs text-slate-500">No scans yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {history.map((item) => (
                <li key={`${item.code}-${item.ts}`} className="flex justify-between text-slate-300">
                  <span className="font-mono">{item.code}</span>
                  <span className="text-slate-500">{new Date(item.ts).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Link className="inline-block text-emerald-400 hover:underline text-sm" to="/register">
          Back to register
        </Link>
      </div>
    </div>
  );
}