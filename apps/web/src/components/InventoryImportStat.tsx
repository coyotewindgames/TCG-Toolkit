interface InventoryImportStatProps {
  label: string;
  value: number;
}

export default function InventoryImportStat({ label, value }: InventoryImportStatProps) {
  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
