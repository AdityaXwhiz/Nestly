import './Card.css';

export function Card({
  as: Component = 'div',
  children,
  interactive = false,
  className = '',
  ...props
}) {
  const interactiveClass = interactive ? 'card-interactive' : '';
  return (
    <Component className={`card ${interactiveClass} ${className}`.trim()} {...props}>
      {children}
    </Component>
  );
}
