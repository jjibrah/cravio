import { Link } from 'react-router-dom';

export function BrandMark({ size }) {
  return <span className="brand-mark" style={size ? { '--mark-size': `${size}px` } : undefined} aria-hidden="true" />;
}

export default function Brand({ to = '/', onClick, className = '', label = 'Cravio home' }) {
  return <Link to={to} onClick={onClick} className={`brand ${className}`} aria-label={label}>
    <span className="brand-word">Cravio</span><BrandMark />
  </Link>;
}
