/** A segmented control: one choice of a few, e.g. System / Light / Dark or Board / List / Graph. */
export function Seg<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the group for assistive tech. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
