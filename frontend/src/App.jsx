import { ClerkProvider, SignedIn, SignedOut, SignIn, useUser } from '@clerk/clerk-react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './Layout.jsx';
import HomeDashboard from './HomeDashboard.jsx';
import ExamRoom from './ExamRoom.jsx';
import Result from './Result.jsx';
import CreateExam from './CreateExam.jsx';
import AddQuestions from './AddQuestions.jsx';
import ExamLogs from './ExamLogs.jsx';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in frontend/.env');
}

function TeacherRoute({ children }) {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return <div className="centered">Loading…</div>;
  const role = user?.publicMetadata?.role;
  if (role !== 'teacher') return <Navigate to="/dashboard" replace />;
  return children;
}

function AuthGate({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <div className="centered">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
    </>
  );
}

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route
            path="/dashboard"
            element={
              <AuthGate>
                <Layout>
                  <HomeDashboard />
                </Layout>
              </AuthGate>
            }
          />

          <Route
            path="/result"
            element={
              <AuthGate>
                <Layout>
                  <Result />
                </Layout>
              </AuthGate>
            }
          />

          {/* Full-screen exam-taking view — no sidebar, manages its own layout for the submitted state */}
          <Route
            path="/exam/:examId"
            element={
              <AuthGate>
                <ExamRoom />
              </AuthGate>
            }
          />

          <Route
            path="/create-exam"
            element={
              <AuthGate>
                <TeacherRoute>
                  <Layout>
                    <CreateExam />
                  </Layout>
                </TeacherRoute>
              </AuthGate>
            }
          />

          <Route
            path="/add-questions"
            element={
              <AuthGate>
                <TeacherRoute>
                  <Layout>
                    <AddQuestions />
                  </Layout>
                </TeacherRoute>
              </AuthGate>
            }
          />

          <Route
            path="/exam-logs"
            element={
              <AuthGate>
                <TeacherRoute>
                  <Layout>
                    <ExamLogs />
                  </Layout>
                </TeacherRoute>
              </AuthGate>
            }
          />

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </ClerkProvider>
  );
}
