import './Button.css';
import { Spinner } from './Spinner.jsx';

export function Button({
  children,
  variant = 'primary',
  type = 'button',
  disabled = false,
  loading = false,
  fullWidth = false,
  className = '',
  onClick,
  ...props
}) {
  const variantClass = `btn-${variant}`;
  const fullClass = fullWidth ? 'btn-full' : '';

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={`btn ${variantClass} ${fullClass} ${className}`.trim()}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
