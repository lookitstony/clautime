import { useState, useEffect, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useCreateClient, useUpdateClient } from './use-clients'
import { usePresentationMode } from '../settings/use-presentation-mode'
import { CLIENT_COLORS } from '../../../../shared/types/client-project'
import type { Client } from '../../../../shared/types/client-project'

const COLOR_NAMES: Record<string, string> = {
  'var(--project-1)': 'Blue',
  'var(--project-2)': 'Amber',
  'var(--project-3)': 'Green',
  'var(--project-4)': 'Red',
  'var(--project-5)': 'Purple',
  'var(--project-6)': 'Pink',
  'var(--project-7)': 'Cyan',
  'var(--project-8)': 'Orange'
}

interface ClientFormProps {
  open: boolean
  onClose: () => void
  client: Client | null // null = create mode, Client = edit mode
}

export function ClientForm({ open, onClose, client }: ClientFormProps): React.JSX.Element {
  const isEdit = client !== null
  const createClient = useCreateClient()
  const updateClient = useUpdateClient()
  const presentationMode = usePresentationMode()

  const [name, setName] = useState('')
  const [stageName, setStageName] = useState('')
  const [color, setColor] = useState<string>(CLIENT_COLORS[0])
  const [billableRate, setBillableRate] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  // Folder sync freshness: the version this editor opened on, kept until the user reloads.
  const [syncVersion, setSyncVersion] = useState<string | undefined>()
  const [stale, setStale] = useState(false)
  const openedFor = useRef<number | null | undefined>(undefined)
  const queryClient = useQueryClient()

  const load = useCallback((source: Client | null): void => {
    if (source) {
      setName(source.name)
      setStageName(source.stageName ?? '')
      setColor(source.color)
      setBillableRate(source.billableRate != null ? String(source.billableRate) : '')
      setEmail(source.email ?? '')
    } else {
      setName('')
      setStageName('')
      setColor(CLIENT_COLORS[0])
      setBillableRate('')
      setEmail('')
    }
    setSyncVersion(source?.syncVersion)
    setStale(false)
    setError('')
  }, [])

  useEffect(() => {
    if (!open) {
      openedFor.current = undefined
      return
    }
    // A query refresh hands in a new object for the same client: keep the draft and its version.
    const key = client?.id ?? null
    if (openedFor.current === key) return
    openedFor.current = key
    load(client)
  }, [open, client, load])

  const handleSubmit = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    setError('')

    const parsedRate = billableRate.trim() ? parseFloat(billableRate) : null
    const rateValue = parsedRate != null && !isNaN(parsedRate) && parsedRate > 0 ? parsedRate : null
    const trimmedEmail = email.trim() || null

    try {
      if (isEdit && client) {
        await updateClient.mutateAsync({
          id: client.id,
          data: {
            name: trimmedName,
            stageName: stageName.trim() || null,
            color,
            billableRate: rateValue,
            email: trimmedEmail,
            ...(syncVersion !== undefined && { expectedSyncVersion: syncVersion })
          }
        })
        toast.success('Client updated')
      } else {
        await createClient.mutateAsync({
          name: trimmedName,
          stageName: stageName.trim() || null,
          color,
          billableRate: rateValue,
          email: trimmedEmail
        })
        toast.success('Client created')
      }
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save client'
      if (message.includes('SYNC_STALE_EDIT')) {
        // Keep the draft; refresh the list so "Load latest" shows what changed.
        setStale(true)
        queryClient.invalidateQueries({ queryKey: ['clients'] })
      } else if (
        message.toLowerCase().includes('unique') ||
        message.toLowerCase().includes('already')
      ) {
        setError('A client with this name already exists')
      } else {
        toast.error(message)
      }
    }
  }

  const isPending = createClient.isPending || updateClient.isPending
  const isValid = name.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md border-[var(--surface-border)] bg-[var(--background-primary)]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Client' : 'Add Client'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the client name and color.'
              : 'Create a new client to organize your projects.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label htmlFor="client-name" className="text-[13px] font-medium">
              Name
            </label>
            <input
              id="client-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValid) handleSubmit()
              }}
              placeholder="Client name"
              autoFocus
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                error ? 'border-red-500' : 'border-[var(--surface-border)]'
              )}
            />
            {error && <p className="text-[12px] text-red-400">{error}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="client-stage-name" className="text-[13px] font-medium">
              Stage Name
            </label>
            <input
              id="client-stage-name"
              type="text"
              value={stageName}
              onChange={(e) => setStageName(e.target.value)}
              placeholder={name || 'Same as client name'}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'border-[var(--surface-border)]'
              )}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Shown in place of the real name when Presentation Mode is on (streaming/demos).
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="client-email" className="text-[13px] font-medium">
              Email
            </label>
            <input
              id="client-email"
              type={presentationMode ? 'password' : 'email'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@example.com"
              className={cn(
                'w-full rounded-md border px-3 py-2 text-[13px]',
                'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                'placeholder:text-[var(--text-muted)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'border-[var(--surface-border)]'
              )}
            />
            <p className="text-[11px] text-[var(--text-muted)]">Required for invoicing</p>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium">Color</label>
            <div className="flex gap-2">
              {CLIENT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Select color ${COLOR_NAMES[c] ?? c}`}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full transition-transform',
                    'hover:scale-110',
                    color === c &&
                      'ring-2 ring-white ring-offset-2 ring-offset-[var(--background-primary)]'
                  )}
                  style={{ backgroundColor: c }}
                >
                  {color === c && <Check size={14} className="text-white" />}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="client-rate" className="text-[13px] font-medium">
              Billable Rate
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-[var(--text-muted)]">$</span>
              <input
                id="client-rate"
                type="number"
                min="0"
                step="0.01"
                value={billableRate}
                onChange={(e) => setBillableRate(e.target.value)}
                placeholder="0.00"
                className={cn(
                  'w-32 rounded-md border px-3 py-2 text-[13px]',
                  'bg-[var(--background-secondary)] text-[var(--text-primary)]',
                  'placeholder:text-[var(--text-muted)]',
                  'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                  'border-[var(--surface-border)]'
                )}
              />
              <span className="text-[12px] text-[var(--text-muted)]">/ hour</span>
            </div>
          </div>
        </div>

        {stale && (
          <div className="flex items-center justify-between gap-2 text-[12px] text-amber-400">
            <span>
              This client changed on another computer since you opened it. Your changes are kept
              until you load the latest values.
            </span>
            <Button variant="outline" size="sm" onClick={() => load(client)}>
              Load latest
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isPending || stale}>
            {isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
