import { Link, NavLink, Outlet } from 'react-router-dom';

export default function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-6">
        <Link to="/" className="font-bold text-lg">
          🃏 TCG Toolkit
        </Link>
        <nav className="flex gap-2 text-sm">
          {[
            ['/register', 'Register'],
            ['/inventory', 'Inventory'],
            ['/tradein', 'Trade-In'],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }: { isActive: boolean }) =>
                `px-3 py-1.5 rounded-lg ${isActive ? 'bg-emerald-500 text-slate-900' : 'hover:bg-slate-800'}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
