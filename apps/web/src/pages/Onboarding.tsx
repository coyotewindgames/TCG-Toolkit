import { Link } from 'react-router-dom';
import { useSession } from '../hooks/useSession';

/**
 * Lightweight post-signup landing. The store + default location are already
 * created at this point; we just point new owners at the next useful steps.
 * Settings is the canonical home for TCGapi.dev / Clover credentials.
 */
export default function OnboardingPage() {
  const session = useSession();
  const name = session.user?.displayName ?? 'there';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Welcome, {name} 👋</h1>
          <p className="text-slate-400">Your shop is ready. Here's what most shops do first.</p>
        </header>

        <ol className="space-y-3">
          <Step
            n={1}
            title="Connect TCGapi.dev"
            body="Add your TCGapi.dev API key so we can pull product images and pricing for your inventory."
            cta="Open Settings"
            to="/settings/integrations"
          />
          <Step
            n={2}
            title="(Optional) Connect Clover"
            body="Wire up your Clover device and webhook secret if you want to take card payments through Toolkit."
            cta="Open Settings"
            to="/settings/integrations"
          />
          <Step
            n={3}
            title="Import your inventory"
            body="Got a CSV from Collectr or another platform? Drop it in the Inventory tools panel."
            cta="Go to Inventory"
            to="/inventory"
          />
        </ol>

        <div className="text-center pt-2">
          <Link to="/inventory" className="text-emerald-400 hover:underline text-sm">
            Skip and go to the dashboard →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, body, cta, to }: { n: number; title: string; body: string; cta: string; to: string }) {
  return (
    <li className="flex gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500 text-slate-900 font-bold flex items-center justify-center">
        {n}
      </div>
      <div className="flex-1">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-slate-400">{body}</p>
      </div>
      <Link
        to={to}
        className="self-center bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 text-sm whitespace-nowrap"
      >
        {cta}
      </Link>
    </li>
  );
}
