import { Field, Input, Toggle } from '@/components/ui/form';

export function TextField({
  label,
  hint,
  name,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  name: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </Field>
  );
}

export function NumberField({
  label,
  hint,
  name,
  value,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  name: string;
  value: string;
  min: number;
  max: number;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </Field>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="text-[13px] font-medium text-fg">{label}</span>
    </div>
  );
}
