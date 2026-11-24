import './Spinner.css';

export function Spinner({ size = 'md', className = '' }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`spinner spinner-${size} ${className}`.trim()}
    >
      <span className="sr-only">Loading...</span>
    </span>
  );
}
