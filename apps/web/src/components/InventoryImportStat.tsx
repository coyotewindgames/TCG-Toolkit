interface InventoryImportStatProps {
  label: string;
  value: number;
}

export default function InventoryImportStat({ label, value }: InventoryImportStatProps) {
  return (
    <div className="bg-card/60 border border-border rounded-lg px-3 py-2">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
