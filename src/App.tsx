import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGateProvider, useAuthGate } from "@/contexts/AuthGateContext";
import DashboardPage from "./pages/DashboardPage";
import CreativeStudioPage from "./pages/CreativeStudioPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import OutputEditorPage from "./pages/OutputEditorPage";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";
import AvatarsManagePage from "./pages/capabilities/AvatarsPage";
import VoicesManagePage from "./pages/capabilities/VoicesPage";
import ScriptsManagePage from "./pages/capabilities/ScriptsPage";
import TrendsPage from "./pages/TrendsPage";
import LoginPage from "./pages/LoginPage";
import ProofTestPage from "./pages/ProofTestPage";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuthGate();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
      <Route path="/creative-studio" element={<ProtectedRoute><CreativeStudioPage /></ProtectedRoute>} />
      <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
      <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetailPage /></ProtectedRoute>} />
      <Route path="/projects/:id/outputs/:outputId" element={<ProtectedRoute><OutputEditorPage /></ProtectedRoute>} />
      <Route path="/capabilities/avatars" element={<ProtectedRoute><AvatarsManagePage /></ProtectedRoute>} />
      <Route path="/capabilities/voices" element={<ProtectedRoute><VoicesManagePage /></ProtectedRoute>} />
      <Route path="/capabilities/scripts" element={<ProtectedRoute><ScriptsManagePage /></ProtectedRoute>} />
      <Route path="/trends" element={<ProtectedRoute><TrendsPage /></ProtectedRoute>} />
      <Route path="/proof-test" element={<ProtectedRoute><ProofTestPage /></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
      <Route path="*" element={<ProtectedRoute><NotFound /></ProtectedRoute>} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner position="top-center" dir="rtl" />
      <AuthGateProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthGateProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
