import './EmptyState.css';

/**
 * Text-only empty state component (Change #10: Restrained, no icons or illustrations).
 */
export function EmptyState({ title, description, children, className = '' }) {
  return (
    <div className={`empty-state ${className}`.trim()} role="status">
      {title && <h3 className="empty-state-title">{title}</h3>}
      {description && <p className="empty-state-description">{description}</p>}
      {children}
    </div>
  );
}
