import { Link } from 'react-router-dom';
import turbocompIcon from '../assets/turbocomp-icon.svg';

/**
 * Public landing page shown to unauthenticated visitors. Offers an equal
 * choice between signing in and creating a new shop, since `/login` alone
 * buries signup behind a small link.
 */
export default function WelcomePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-navy text-ink p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div>
          <img src={turbocompIcon} alt="" className="h-12 w-12 mx-auto mb-2" aria-hidden />
          <h1 className="text-3xl font-bold">Turbocomp</h1>
          <p className="text-ink-muted mt-2">
            Inventory, register, and trade-ins for trading card shops.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            to="/signup"
            className="block bg-brand text-navy font-semibold rounded-lg py-3 hover:bg-brand-dark"
          >
            Create a shop
          </Link>
          <Link
            to="/login"
            className="block bg-track hover:bg-card border border-border rounded-lg py-3 font-semibold text-ink"
          >
            Sign in
          </Link>
        </div>

        <p className="text-xs text-ink-dim">
          New here? Create a shop to set up your store, locations, and integrations.
        </p>
      </div>
    </div>
  );
}
