type Props = {
  score: number;
  label?: string;
};

export default function ScoreBadge({ score, label }: Props) {
  const color =
    score >= 80
      ? "text-emerald-700 border-emerald-200 bg-emerald-50"
      : score >= 50
        ? "text-amber-700 border-amber-200 bg-amber-50"
        : "text-red-700 border-red-200 bg-red-50";

  return (
    <div
      className={`inline-flex flex-col items-center rounded-xl border px-6 py-3 ${color}`}
    >
      <span className="text-4xl font-bold tabular-nums">{score}</span>
      <span className="text-xs uppercase tracking-widest opacity-70 mt-0.5">
        {label ?? "score"}
      </span>
    </div>
  );
}
