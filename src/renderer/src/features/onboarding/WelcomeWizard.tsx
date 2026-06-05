import { useCallback } from 'react'
import { Activity, BarChart3, FileText, Monitor, Settings, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCompleteSetup } from './use-onboarding'

interface WelcomeWizardProps {
  onComplete: () => void
}

const features = [
  {
    icon: Activity,
    title: 'Live View',
    desc: 'See active Claude sessions in real time with processing indicators'
  },
  {
    icon: FileText,
    title: 'Sessions',
    desc: 'Browse your full session history with prompts, tokens, and time breakdowns'
  },
  {
    icon: BarChart3,
    title: 'Reports & Analytics',
    desc: 'Generate time reports by client or project, and visualize trends'
  },
  {
    icon: Monitor,
    title: 'Desktop Widgets',
    desc: 'Pin floating widgets to your desktop to monitor projects at a glance'
  },
  {
    icon: Users,
    title: 'Clients & Projects',
    desc: 'Organize work by client and project for accurate billing and tracking'
  },
  {
    icon: Settings,
    title: 'Customizable',
    desc: 'Themes, alert sounds, idle timeouts, auto-updates, and more'
  }
]

export function WelcomeWizard({ onComplete }: WelcomeWizardProps): React.JSX.Element {
  const completeSetup = useCompleteSetup()

  const handleGetStarted = useCallback(async () => {
    await completeSetup.mutateAsync()
    onComplete()
  }, [completeSetup, onComplete])

  return (
    <Dialog open modal>
      <DialogContent
        className="max-w-md border-[var(--surface-border)] bg-[var(--background-primary)] text-[var(--text-primary)] [&>button]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-4 py-2">
          <div className="text-center">
            <DialogTitle className="text-xl font-bold">Welcome to ClauTime</DialogTitle>
            <DialogDescription className="mt-1 text-[var(--text-muted)]">
              Track your Claude Code sessions automatically — no setup required.
            </DialogDescription>
          </div>

          <div className="grid gap-3">
            {features.map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="flex items-start gap-3 rounded-lg px-3 py-2 bg-[var(--background-secondary)]"
              >
                <Icon size={18} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">{title}</p>
                  <p className="text-[12px] text-[var(--text-muted)]">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="text-center text-[12px] text-[var(--text-muted)]">
            Your projects have been auto-detected and sessions are being scanned now.
          </p>

          <Button
            onClick={handleGetStarted}
            disabled={completeSetup.isPending}
            className="w-full bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            Get Started
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
