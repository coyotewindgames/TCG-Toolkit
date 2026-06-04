import { Link } from 'react-router-dom';

/**
 * Public landing page shown to unauthenticated visitors. Offers an equal
 * choice between signing in and creating a new shop, since `/login` alone
 * buries signup behind a small link.
 */
export default function WelcomePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div>
          <div className="text-5xl mb-2" aria-hidden>
            🃏
          </div>
          <h1 className="text-3xl font-bold">TCG Toolkit</h1>
          <p className="text-slate-400 mt-2">
            Inventory, register, and trade-ins for trading card shops.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            to="/signup"
            className="block bg-emerald-500 text-slate-900 font-semibold rounded-lg py-3 hover:bg-emerald-400"
          >
            Create a shop
          </Link>
          <Link
            to="/login"
            className="block bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg py-3 font-semibold"
          >
            Sign in
          </Link>
        </div>

        <p className="text-xs text-slate-500">
          New here? Create a shop to set up your store, locations, and integrations.
        </p>
      </div>
    </div>
  );
}
