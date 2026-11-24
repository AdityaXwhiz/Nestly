import { Outlet } from 'react-router-dom';
import { Header } from './Header.jsx';
import { Footer } from './Footer.jsx';

export function Layout() {
  return (
    <>
      <Header />
      <main className="container" style={{ flex: 1, paddingTop: 'var(--space-6)', paddingBottom: 'var(--space-12)' }}>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
