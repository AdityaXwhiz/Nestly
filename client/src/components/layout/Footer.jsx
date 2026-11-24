import './Footer.css';

export function Footer() {
  return (
    <footer className="app-footer">
      <div className="container footer-inner">
        <div>
          <p>© {new Date().getFullYear()} Nestly. Event spaces & curated services.</p>
        </div>
        <p className="footer-disclaimer">
          Catalog discovery and calendar availability are indicative. Dates and pricing are authoritatively validated and locked during checkout.
        </p>
      </div>
    </footer>
  );
}
