# @tcg/web

React 19 + Vite PWA for the register, inventory, and trade-in surfaces.

## State management boundaries

We deliberately split state across two libraries and avoid a third:

| Concern                                            | Library              |
|----------------------------------------------------|----------------------|
| Anything fetched from `apps/api` (products, orders, prices, trades, sockets-as-events) | **TanStack Query**   |
| Ephemeral UI state (drawer open, active register tab, scan buffer) | **Zustand**          |
| Form state                                         | local component state |

Rules:

- Do **not** mirror server data into Zustand. Read it from a TanStack Query
  cache and invalidate via mutation `onSuccess`/socket events.
- Do **not** introduce Redux, Recoil, MobX, or React Context-as-store. Context
  remains fine for theming / i18n / auth-user identity if needed.
- Zustand stores live in `src/state/`. Keep them small (one slice per
  concern); compose at the call site rather than building a monolith.

## Hardware (MVP)

The register uses Clover hardware. `VITE_CLOVER_DEVICE_ID` selects the target
terminal at checkout. A future `PosProvider` swap on the API side is
transparent to this app.
