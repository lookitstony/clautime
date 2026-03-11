import { useState } from 'react'
import { AlertTriangle, Users, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { ClientCard } from './ClientCard'
import { ClientForm } from './ClientForm'
import { useClients } from './use-clients'
import type { Client } from '../../../../shared/types/client-project'

function ClientListSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-1 px-4">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full bg-[var(--background-elevated)]" />
      ))}
    </div>
  )
}

export function ClientsPage(): React.JSX.Element {
  const { data: clients, isLoading, error } = useClients()
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set())
  const [clientFormOpen, setClientFormOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)

  const isEmpty = !isLoading && !error && (!clients || clients.length === 0)

  const toggleClient = (clientId: number): void => {
    setExpandedClients((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) {
        next.delete(clientId)
      } else {
        next.add(clientId)
      }
      return next
    })
  }

  const handleEditClient = (client: Client): void => {
    setEditingClient(client)
    setClientFormOpen(true)
  }

  const handleAddClient = (): void => {
    setEditingClient(null)
    setClientFormOpen(true)
  }

  const handleFormClose = (): void => {
    setClientFormOpen(false)
    setEditingClient(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4">
        <h1 className="text-base font-semibold">Projects &amp; Clients</h1>
        <Button size="sm" onClick={handleAddClient} className="gap-1.5">
          <Plus size={14} />
          Add Client
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && <ClientListSkeleton />}

        {error && (
          <EmptyState
            icon={AlertTriangle}
            title="Failed to Load Clients"
            description={error.message}
          />
        )}

        {isEmpty && (
          <EmptyState
            icon={Users}
            title="No clients configured"
            description="Add clients and projects to organize your sessions"
            action={
              <Button onClick={handleAddClient}>
                Add Client
              </Button>
            }
          />
        )}

        {!isLoading && !isEmpty && clients && (
          <div className="divide-y divide-[var(--surface-border)]">
            {clients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                isExpanded={expandedClients.has(client.id)}
                onToggle={() => toggleClient(client.id)}
                onEdit={() => handleEditClient(client)}
              />
            ))}
          </div>
        )}
      </div>

      <ClientForm
        open={clientFormOpen}
        onClose={handleFormClose}
        client={editingClient}
      />
    </div>
  )
}
