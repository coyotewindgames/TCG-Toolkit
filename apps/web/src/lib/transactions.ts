export type TransactionMode = 'buy' | 'sell' | 'trade';

export interface TransactionDraftItem {
  id: string;
  title: string;
  subtitle?: string;
  unitCents: number;
  quantity: number;
}

export interface TransactionDraftState {
  mode: TransactionMode;
  items: TransactionDraftItem[];
}

export type TransactionDraftAction =
  | { type: 'set_mode'; mode: TransactionMode }
  | { type: 'add_item'; item: TransactionDraftItem }
  | { type: 'remove_item'; id: string }
  | { type: 'set_quantity'; id: string; quantity: number }
  | { type: 'clear' };

export const TRANSACTION_MODES: Array<{ id: TransactionMode; label: string }> = [
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'trade', label: 'Trade' },
];

export function createInitialDraftState(mode: TransactionMode = 'sell'): TransactionDraftState {
  return {
    mode,
    items: [],
  };
}

export function transactionDraftReducer(
  state: TransactionDraftState,
  action: TransactionDraftAction,
): TransactionDraftState {
  switch (action.type) {
    case 'set_mode':
      return {
        ...state,
        mode: action.mode,
      };
    case 'add_item': {
      const existing = state.items.find((item) => item.id === action.item.id);
      if (existing) {
        return {
          ...state,
          items: state.items.map((item) =>
            item.id === action.item.id
              ? { ...item, quantity: item.quantity + Math.max(1, action.item.quantity) }
              : item,
          ),
        };
      }
      return {
        ...state,
        items: [...state.items, { ...action.item, quantity: Math.max(1, action.item.quantity) }],
      };
    }
    case 'remove_item':
      return {
        ...state,
        items: state.items.filter((item) => item.id !== action.id),
      };
    case 'set_quantity':
      return {
        ...state,
        items: state.items
          .map((item) =>
            item.id === action.id ? { ...item, quantity: Math.max(1, action.quantity) } : item,
          )
          .filter((item) => item.quantity > 0),
      };
    case 'clear':
      return {
        ...state,
        items: [],
      };
    default:
      return state;
  }
}

export function centsToMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function draftTotals(items: TransactionDraftItem[]) {
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotalCents = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  return {
    itemCount,
    subtotalCents,
  };
}
