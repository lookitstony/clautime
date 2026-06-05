import { useCallback, useRef, type KeyboardEvent } from 'react'
import { useNavigate, useLocation } from 'react-router'
import {
  LayoutList,
  Activity,
  FileBarChart,
  BarChart3,
  FolderKanban,
  Receipt,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUIStore } from '@/stores/use-ui-store'
import { cn } from '@/lib/utils'

interface NavItem {
  icon: LucideIcon
  label: string
  route: string
}

const navItems: NavItem[] = [
  { icon: LayoutList, label: 'Sessions', route: '/sessions' },
  { icon: Activity, label: 'Live', route: '/' },
  { icon: FileBarChart, label: 'Reports', route: '/reports' },
  { icon: BarChart3, label: 'Analytics', route: '/analytics' },
  { icon: FolderKanban, label: 'Projects', route: '/clients' },
  { icon: Receipt, label: 'Invoicing', route: '/invoicing' },
  { icon: Settings, label: 'Settings', route: '/settings' }
]

export function ActivityBar(): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])

  const isActive = useCallback(
    (route: string) => {
      if (route === '/') return location.pathname === '/'
      return location.pathname === route
    },
    [location.pathname]
  )

  const handleClick = useCallback(
    (route: string) => {
      setActiveView(route)
      navigate(route)
    },
    [navigate, setActiveView]
  )

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>, index: number) => {
    let nextIndex: number | null = null

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (index + 1) % navItems.length
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (index - 1 + navItems.length) % navItems.length
    }

    if (nextIndex !== null) {
      buttonsRef.current[nextIndex]?.focus()
    }
  }, [])

  return (
    <nav
      role="navigation"
      aria-label="Main navigation"
      className="flex w-14 flex-col items-center gap-2 bg-[var(--background-secondary)] py-2"
    >
      {navItems.map((item, index) => {
        const active = isActive(item.route)
        const Icon = item.icon
        return (
          <Tooltip key={item.route}>
            <TooltipTrigger asChild>
              <button
                ref={(el) => {
                  buttonsRef.current[index] = el
                }}
                onClick={() => handleClick(item.route)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-md transition-colors',
                  active
                    ? 'border-l-[3px] border-l-[var(--accent)] bg-[rgba(var(--accent-rgb),0.1)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--background-elevated)]'
                )}
              >
                <Icon size={20} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {item.label}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
