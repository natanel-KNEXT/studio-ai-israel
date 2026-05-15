import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuthGate } from '@/contexts/AuthGateContext';
import {
  LayoutDashboard, Sparkles, FolderOpen, Settings,
  ChevronRight, ChevronLeft, Video, UserCircle, Mic, FileText,
  ChevronDown, Flame, X, LogOut
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { OpenGuideTourButton } from '@/components/GuidedTour';
import { useIsMobile } from '@/hooks/use-mobile';

const mainMenuItems = [
  { title: 'דשבורד', icon: LayoutDashboard, path: '/' },
  { title: 'סטודיו קריאייטיב', icon: Sparkles, path: '/creative-studio' },
  { title: 'פרויקטים', icon: FolderOpen, path: '/projects' },
  { title: 'טרנדים חזקים', icon: Flame, path: '/trends' },
];

const capabilityItems = [
  { title: 'אווטארים', icon: UserCircle, path: '/capabilities/avatars' },
  { title: 'דיבוב / קול', icon: Mic, path: '/capabilities/voices' },
  { title: 'תסריטים', icon: FileText, path: '/capabilities/scripts' },
];

// Global event for toggling mobile sidebar
export const sidebarEvents = new EventTarget();

function LogoutButton({ collapsed }: { collapsed: boolean }) {
  const { logout } = useAuthGate();
  return (
    <button
      onClick={logout}
      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
    >
      <LogOut className="w-5 h-5 flex-shrink-0" />
      {!collapsed && <span>התנתק</span>}
    </button>
  );
}

export function AppSidebar() {
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(
    location.pathname.startsWith('/capabilities')
  );

  const isCapabilityActive = capabilityItems.some(
    item => location.pathname.startsWith(item.path)
  );

  // Listen for toggle events from header hamburger
  useEffect(() => {
    const handler = () => setMobileOpen(prev => !prev);
    sidebarEvents.addEventListener('toggle', handler);
    return () => sidebarEvents.removeEventListener('toggle', handler);
  }, []);

  // Close mobile sidebar on route change
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [location.pathname, isMobile]);

  // Mobile: render overlay + drawer
  if (isMobile) {
    return (
      <>
        {/* Overlay */}
        {mobileOpen && (
          <div
            className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
        )}
        {/* Drawer */}
        <aside
          className={cn(
            'fixed top-0 right-0 h-screen w-64 bg-sidebar border-l border-sidebar-border flex flex-col z-50 transition-transform duration-300',
            mobileOpen ? 'translate-x-0' : 'translate-x-full'
          )}
        >
          {/* Header */}
          <div className="h-14 flex items-center justify-between px-4 border-b border-sidebar-border">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg gradient-gold flex items-center justify-center">
                <Video className="w-3.5 h-3.5 text-primary-foreground" />
              </div>
              <span className="font-rubik font-bold text-base text-foreground">סטודיו AI</span>
            </Link>
            <button onClick={() => setMobileOpen(false)} className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-sidebar-accent text-sidebar-foreground">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Nav */}
          <nav className="flex-1 py-3 px-2 overflow-y-auto">
            <ul className="space-y-1">
              {mainMenuItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.path ||
                  (item.path !== '/' && location.pathname.startsWith(item.path));
                return (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                        isActive
                          ? 'bg-primary/10 text-primary shadow-gold'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-primary')} />
                      <span>{item.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {/* Capabilities */}
            <div className="mt-4">
              <button
                onClick={() => setCapabilitiesOpen(!capabilitiesOpen)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                  isCapabilityActive ? 'text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent'
                )}
              >
                <span>יכולות</span>
                <ChevronDown className={cn('w-4 h-4 transition-transform', capabilitiesOpen && 'rotate-180')} />
              </button>
              {capabilitiesOpen && (
                <ul className="space-y-1 mt-1">
                  {capabilityItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = location.pathname.startsWith(item.path);
                    return (
                      <li key={item.path}>
                        <Link
                          to={item.path}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 pr-6',
                            isActive
                              ? 'bg-primary/10 text-primary shadow-gold'
                              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                          )}
                        >
                          <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-primary')} />
                          <span>{item.title}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Settings */}
            <ul className="mt-4 space-y-1">
              <li>
                <Link
                  to="/settings"
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                    location.pathname === '/settings'
                      ? 'bg-primary/10 text-primary shadow-gold'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )}
                >
                  <Settings className={cn('w-5 h-5 flex-shrink-0', location.pathname === '/settings' && 'text-primary')} />
                  <span>הגדרות</span>
                </Link>
              </li>
            </ul>
          </nav>

          <div className="p-3 border-t border-sidebar-border space-y-2">
            <OpenGuideTourButton />
            <LogoutButton collapsed={false} />
            <div className="rounded-lg bg-sidebar-accent p-2.5">
              <p className="text-xs text-muted-foreground">גרסה 1.0.0</p>
            </div>
          </div>
        </aside>
      </>
    );
  }

  // Desktop: original sidebar
  return (
    <aside
      className={cn(
        'fixed top-0 right-0 h-screen bg-sidebar border-l border-sidebar-border flex flex-col z-50 transition-all duration-300',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-sidebar-border">
        {!collapsed && (
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg gradient-gold flex items-center justify-center">
              <Video className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-rubik font-bold text-lg text-foreground">סטודיו AI</span>
          </Link>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
        >
          {collapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <ul className="space-y-1">
          {mainMenuItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path ||
              (item.path !== '/' && location.pathname.startsWith(item.path));
            return (
              <li key={item.path}>
                <Link
                  to={item.path}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                    isActive
                      ? 'bg-primary/10 text-primary shadow-gold'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )}
                >
                  <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-primary')} />
                  {!collapsed && <span>{item.title}</span>}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Capabilities Section */}
        <div className="mt-4">
          {!collapsed && (
            <button
              onClick={() => setCapabilitiesOpen(!capabilitiesOpen)}
              className={cn(
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200',
                isCapabilityActive
                  ? 'text-primary'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent'
              )}
            >
              <span>יכולות</span>
              <ChevronDown className={cn('w-4 h-4 transition-transform', capabilitiesOpen && 'rotate-180')} />
            </button>
          )}
          {(capabilitiesOpen || collapsed) && (
            <ul className="space-y-1 mt-1">
              {capabilityItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.path);
                return (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                        !collapsed && 'pr-6',
                        isActive
                          ? 'bg-primary/10 text-primary shadow-gold'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      )}
                    >
                      <Icon className={cn('w-5 h-5 flex-shrink-0', isActive && 'text-primary')} />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Settings */}
        <ul className="mt-4 space-y-1">
          <li>
            <Link
              to="/settings"
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                location.pathname === '/settings'
                  ? 'bg-primary/10 text-primary shadow-gold'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <Settings className={cn('w-5 h-5 flex-shrink-0', location.pathname === '/settings' && 'text-primary')} />
              {!collapsed && <span>הגדרות</span>}
            </Link>
          </li>
        </ul>
      </nav>

      <div className={cn("border-t border-sidebar-border", collapsed ? "p-2" : "p-4 space-y-2")}>
        {!collapsed && <OpenGuideTourButton />}
        <LogoutButton collapsed={collapsed} />
        {!collapsed && (
          <div className="rounded-lg bg-sidebar-accent p-3">
            <p className="text-xs text-muted-foreground">גרסה 1.0.0</p>
          </div>
        )}
      </div>
    </aside>
  );
}
