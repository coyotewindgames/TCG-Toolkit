interface RegisterSummaryRowProps {
  label: string;
  value: string;
  large?: boolean;
}

export default function RegisterSummaryRow({ label, value, large }: RegisterSummaryRowProps) {
  return (
    <div className={`flex justify-between ${large ? 'text-2xl font-bold' : 'text-sm'} py-1`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
