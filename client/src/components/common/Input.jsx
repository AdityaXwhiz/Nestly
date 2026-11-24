import { useId } from 'react';
import './Input.css';

export function Input({
  label,
  id: explicitId,
  error,
  helperText,
  className = '',
  ...props
}) {
  const generatedId = useId();
  const id = explicitId || generatedId;
  const errorId = error ? `${id}-error` : undefined;
  const helperId = helperText ? `${id}-helper` : undefined;

  return (
    <div className={`input-group ${className}`.trim()}>
      {label && (
        <label htmlFor={id} className="input-label">
          {label}
        </label>
      )}
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={[errorId, helperId].filter(Boolean).join(' ') || undefined}
        className={`input-control ${error ? 'has-error' : ''}`.trim()}
        {...props}
      />
      {error && (
        <span id={errorId} className="input-error" role="alert">
          {error}
        </span>
      )}
      {!error && helperText && (
        <span id={helperId} className="input-helper">
          {helperText}
        </span>
      )}
    </div>
  );
}
