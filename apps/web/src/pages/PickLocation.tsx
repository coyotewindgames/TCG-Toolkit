import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { setLocationId } from '../lib/session';
import { useSession } from '../hooks/useSession';

interface LocationsResponse {
  locations: Array<{ id: string; name: string }>;
}

export default function PickLocationPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<LocationsResponse>('/locations'),
  });

  // If the session already has a valid location selected, fast-forward.
  useEffect(() => {
    if (!data) return;
    if (session.locationId && data.locations.some((l) => l.id === session.locationId)) {
      navigate('/inventory', { replace: true });
    } else if (data.locations.length === 1) {
      setLocationId(data.locations[0].id);
      navigate('/inventory', { replace: true });
    }
  }, [data, session.locationId, navigate]);

  function pick(id: string) {
    setLocationId(id);
    navigate('/inventory', { replace: true });
  }

  async function createLocation(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const created = await api.post<{ id: string; name: string }>('/locations', { name: newName });
      setLocationId(created.id);
      navigate('/inventory', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create location');
      void refetch();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Choose a location</h1>
          <p className="text-sm text-slate-400">
            Pick which store location you're working from. We'll remember it on this device.
          </p>
        </div>

        {isLoading && <p className="text-sm text-slate-400">Loading…</p>}

        {data && data.locations.length > 0 && (
          <ul className="space-y-2">
            {data.locations.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => pick(l.id)}
                  className="w-full text-left bg-slate-950 hover:bg-slate-800 border border-slate-700 rounded-lg px-3 py-2"
                >
                  {l.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {(session.user?.role === 'owner' || session.user?.role === 'manager') && (
          <form onSubmit={createLocation} className="space-y-2 pt-2 border-t border-slate-800">
            <span className="block text-xs uppercase tracking-wide text-slate-400">Add a location</span>
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Downtown"
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={!newName.trim() || creating}
                className="bg-emerald-500 text-slate-900 font-semibold rounded-lg px-3 disabled:opacity-50"
              >
                {creating ? '…' : 'Add'}
              </button>
            </div>
            {error && <p className="text-sm text-rose-400">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
