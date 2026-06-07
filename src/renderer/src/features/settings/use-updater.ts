import { useEffect } from 'react'
import { toast } from 'sonner'

// Module-level flag so the global listener can tell user-initiated checks
// (where we want "up to date" / error feedback) apart from background
// periodic ticks (where silence is the right answer).
let userTriggeredCheck = false

export function triggerUpdateCheck(): void {
  userTriggeredCheck = true
  window.api.updater.checkForUpdates()
  toast.info('Checking for updates…')
}

export function useUpdaterNotifications(): void {
  useEffect(() => {
    window.api.updater.onUpdateAvailable((info) => {
      userTriggeredCheck = false
      toast.success(`Update available: v${info.version}`, {
        duration: 10_000,
        action: {
          label: 'Download',
          onClick: () => {
            window.api.updater.downloadAndInstall()
            toast.info('Downloading update…')
          }
        }
      })
    })

    window.api.updater.onUpdateNotAvailable(() => {
      if (userTriggeredCheck) {
        userTriggeredCheck = false
        toast.success("You're on the latest version")
      }
    })

    window.api.updater.onUpdateDownloaded(() => {
      toast.success('Update ready. Restart to apply.', {
        duration: 15_000,
        action: {
          label: 'Restart',
          onClick: () => window.api.updater.downloadAndInstall()
        }
      })
    })

    window.api.updater.onUpdateError((info) => {
      if (userTriggeredCheck) {
        userTriggeredCheck = false
        toast.error(`Update check failed: ${info.message}`)
      }
    })
  }, [])
}
