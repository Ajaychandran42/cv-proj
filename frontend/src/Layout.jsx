import { useState } from 'react';
import { useUser, UserButton } from '@clerk/clerk-react';
import Sidebar from './Sidebar.jsx';
import { getStoredTheme, toggleTheme } from './theme.js';

export default function Layout({ children }) {
  const { user } = useUser();
  const role = user?.publicMetadata?.role === 'teacher' ? 'teacher' : 'student';
  const [theme, setTheme] = useState(getStoredTheme());

  return (
    <div className="app-shell">
      <Sidebar role={role} />
      <div className="app-main">
        <header className="topbar">
          <span className="bell">🔔</span>
          <div className="topbar-right">
            <button className="theme-toggle" onClick={() => setTheme(toggleTheme())} title="Toggle dark mode">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <span>Hello, {role === 'teacher' ? 'Teacher' : 'Student'}</span>
            <UserButton afterSignOutUrl="/" />
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
