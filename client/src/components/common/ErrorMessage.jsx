import './ErrorMessage.css';

export function ErrorMessage({ message, requestId, title, className = '' }) {
  if (!message) return null;

  return (
    <div className={`error-banner ${className}`.trim()} role="alert">
      {title && <span className="error-title">{title}</span>}
      <span>{message}</span>
      {requestId && (
        <span className="error-request-id">
          Reference ID: {requestId}
        </span>
      )}
    </div>
  );
}
