import { useId } from 'react';
import './Select.css';

export function Select({
  label,
  id: explicitId,
  options = [],
  error,
  className = '',
  children,
  ...props
}) {
  const generatedId = useId();
  const id = explicitId || generatedId;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={`select-group ${className}`.trim()}>
      {label && (
        <label htmlFor={id} className="select-label">
          {label}
        </label>
      )}
      <select
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId}
        className="select-control"
        {...props}
      >
        {children ||
          options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
      </select>
      {error && (
        <span id={errorId} className="select-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
